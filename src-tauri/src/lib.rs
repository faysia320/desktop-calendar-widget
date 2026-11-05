mod desktop_pin;
mod event_cache;
mod oauth;
mod single_instance;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chrono::NaiveDate;
use event_cache::{CachedEvents, EventCache};
use oauth::{CalendarEvent, NewEvent, Provider, ProviderStatus};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use windows_sys::Win32::Foundation::RECT;

const MAIN_LABEL: &str = "main";
const EDITOR_LABEL: &str = "event-editor";
const ENV_FILE: &str = ".env.local";
const POSITION_FILE: &str = "window-position.json";
const EVENT_CACHE_FILE: &str = "event-cache.json";
const POSITION_SAVE_DELAY: Duration = Duration::from_millis(500);
// 창 왼쪽 위 모서리만 걸친 위치로 복원되어 위젯을 잡을 수 없게 되는 것을 막습니다.
const MIN_VISIBLE_PX: i32 = 100;
const DESKTOP_WAIT_TIMEOUT: Duration = Duration::from_secs(60);
const DESKTOP_POLL_INTERVAL: Duration = Duration::from_millis(500);
// Explorer가 Progman을 만든 직후에는 자식 창이 아직 준비되지 않아 잠시 기다립니다.
const DESKTOP_SETTLE_DELAY: Duration = Duration::from_secs(2);

#[derive(Default)]
struct WidgetState {
    summoned: AtomicBool,
    quitting: AtomicBool,
    position_save_generation: AtomicU64,
    // 최대화 중일 때만 값이 있으며, 되돌아갈 화면 기준 위치와 크기입니다.
    normal_rect: Mutex<Option<RECT>>,
    shortcut_error: Mutex<Option<String>>,
}

/// 최대화 중에도 x, y, 크기는 최대화 전 값을 저장합니다.
/// 예전 파일의 `[x, y]` 형식도 그대로 읽히도록 나머지는 선택 값입니다.
#[derive(Serialize, Deserialize)]
struct Placement {
    x: i32,
    y: i32,
    #[serde(default)]
    width: Option<i32>,
    #[serde(default)]
    height: Option<i32>,
    #[serde(default)]
    maximized: bool,
}

fn position_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(POSITION_FILE))
}

fn save_position(app: &AppHandle) -> Option<()> {
    let window = app.get_webview_window(MAIN_LABEL)?;
    let normal_rect = *app.state::<WidgetState>().normal_rect.lock().unwrap();
    let rect = match normal_rect {
        Some(rect) => rect,
        None => desktop_pin::screen_rect(&window)?,
    };
    let placement = Placement {
        x: rect.left,
        y: rect.top,
        width: Some(rect.right - rect.left),
        height: Some(rect.bottom - rect.top),
        maximized: normal_rect.is_some(),
    };
    let path = position_path(app)?;
    std::fs::create_dir_all(path.parent()?).ok()?;
    std::fs::write(path, serde_json::to_vec(&placement).ok()?).ok()
}

fn set_maximized(app: &AppHandle, maximized: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| tauri::Error::WindowNotFound.to_string())?;
    let state = app.state::<WidgetState>();
    let mut normal_rect = state.normal_rect.lock().unwrap();

    if maximized {
        if normal_rect.is_some() {
            return Ok(());
        }
        let current = desktop_pin::screen_rect(&window).ok_or("창 위치를 읽을 수 없습니다.")?;
        let area = desktop_pin::work_area(&window).ok_or("모니터 영역을 읽을 수 없습니다.")?;
        desktop_pin::move_to(&window, area)?;
        *normal_rect = Some(current);
    } else if let Some(rect) = *normal_rect {
        desktop_pin::move_to(&window, rect)?;
        *normal_rect = None;
    }
    Ok(())
}

// 드래그 중에는 이동 이벤트가 연달아 오므로 움직임이 멈춘 뒤 한 번만 저장합니다.
fn schedule_position_save(app: &AppHandle) {
    let state = app.state::<WidgetState>();
    let generation = state.position_save_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(POSITION_SAVE_DELAY);
        let state = app.state::<WidgetState>();
        if state.position_save_generation.load(Ordering::SeqCst) == generation {
            save_position(&app);
        }
    });
}

/// 저장된 위치와 크기를 적용하고, 최대화 상태였는지 돌려줍니다.
fn restore_position(app: &AppHandle) -> Option<bool> {
    let window = app.get_webview_window(MAIN_LABEL)?;
    let saved = std::fs::read(position_path(app)?).ok()?;
    let placement: Placement = serde_json::from_slice(&saved).ok()?;
    let (x, y) = (placement.x, placement.y);
    // 저장할 때 쓰던 모니터가 빠졌으면 기본 위치에 둡니다.
    let visible = window.available_monitors().ok()?.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        x + MIN_VISIBLE_PX > origin.x
            && y + MIN_VISIBLE_PX > origin.y
            && x + MIN_VISIBLE_PX < origin.x + size.width as i32
            && y + MIN_VISIBLE_PX < origin.y + size.height as i32
    });
    if !visible {
        return Some(false);
    }
    window.set_position(PhysicalPosition::new(x, y)).ok()?;
    if let (Some(width), Some(height)) = (placement.width, placement.height) {
        window
            .set_size(PhysicalSize::new(width as u32, height as u32))
            .ok()?;
    }
    Some(placement.maximized)
}

fn wait_for_desktop() {
    let started = Instant::now();
    while !desktop_pin::desktop_ready() && started.elapsed() < DESKTOP_WAIT_TIMEOUT {
        std::thread::sleep(DESKTOP_POLL_INTERVAL);
    }
    std::thread::sleep(DESKTOP_SETTLE_DELAY);
}

// Explorer가 재시작되면 부모인 바탕화면 창과 함께 위젯 창도 사라지므로 앱을 다시 띄웁니다.
fn restart_when_desktop_returns(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // 사라진 직후에는 예전 Progman이 아직 보일 수 있어 먼저 기다립니다.
        std::thread::sleep(DESKTOP_SETTLE_DELAY);
        wait_for_desktop();
        single_instance::release();
        app.restart();
    });
}

fn place_initially(app: &AppHandle, maximized: bool) {
    if let Err(error) = place_window(app, false) {
        eprintln!("위젯 위치 변경 실패: {error}");
    }
    if maximized {
        if let Err(error) = set_maximized(app, true) {
            eprintln!("위젯 최대화 실패: {error}");
        }
    }
}

#[derive(Serialize)]
struct WidgetStatus {
    maximized: bool,
    shortcut_error: Option<String>,
}

/// 단축키로 불렀으면 맨 위에, 그 외에는 바탕화면에 둡니다.
fn place_window(app: &AppHandle, summoned: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| tauri::Error::WindowNotFound.to_string())?;

    if summoned {
        desktop_pin::float_on_top(&window)?;
    } else {
        desktop_pin::pin_to_desktop(&window)?;
    }
    apply_zoom(&window, summoned);
    Ok(())
}

fn apply_zoom(window: &WebviewWindow, summoned: bool) {
    let zoom = if summoned {
        desktop_pin::floating_zoom(window)
    } else {
        1.0
    };
    if let Err(error) = window.set_zoom(zoom) {
        eprintln!("위젯 배율 변경 실패: {error}");
    }
}

/// 맨 앞으로 불러온 상태와 바탕화면 고정 상태를 전환합니다.
fn toggle_summoned(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<WidgetState>();
    let summoned = !state.summoned.load(Ordering::SeqCst);
    place_window(app, summoned)?;
    state.summoned.store(summoned, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn widget_status(state: State<'_, WidgetState>) -> WidgetStatus {
    WidgetStatus {
        maximized: state.normal_rect.lock().unwrap().is_some(),
        shortcut_error: state.shortcut_error.lock().unwrap().clone(),
    }
}

// Tauri 기본 최대화는 바탕화면 자식 창을 주 모니터로 보내므로 직접 처리합니다.
#[tauri::command]
fn toggle_maximized(app: AppHandle, state: State<'_, WidgetState>) -> Result<bool, String> {
    let maximized = state.normal_rect.lock().unwrap().is_none();
    set_maximized(&app, maximized)?;
    schedule_position_save(&app);
    Ok(maximized)
}

#[tauri::command]
fn quit(app: AppHandle, state: State<'_, WidgetState>) {
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    // 개발 빌드는 Vite 서버 없이 뜨지 않으므로 로그인 때 실행되면 빈 창만 나옵니다.
    if cfg!(debug_assertions) {
        return Err("개발 빌드에서는 등록할 수 없습니다.".to_string());
    }
    let autostart = app.autolaunch();
    let result = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
fn provider_status() -> Vec<ProviderStatus> {
    oauth::provider_status()
}

#[tauri::command]
async fn connect(app: AppHandle, provider: Provider) -> Result<(), String> {
    oauth::connect(&app, provider).await
}

#[tauri::command]
fn cached_events(
    cache: State<'_, EventCache>,
    provider: Provider,
    from: String,
    to: String,
) -> Option<CachedEvents> {
    cache.load(provider, &from, &to)
}

#[tauri::command]
async fn fetch_events(
    cache: State<'_, EventCache>,
    provider: Provider,
    from: String,
    to: String,
) -> Result<Vec<CalendarEvent>, String> {
    let events = oauth::fetch_events(provider, &from, &to).await?;
    // 저장에 실패해도 받아 온 일정은 그대로 보여 줍니다.
    if let Err(error) = cache.store(provider, &from, &to, events.clone()) {
        eprintln!("일정 캐시 저장 실패: {error}");
    }
    Ok(events)
}

#[tauri::command]
async fn create_google_event(app: AppHandle, event: NewEvent) -> Result<CalendarEvent, String> {
    let created = oauth::create_google_event(&event).await?;
    app.emit("events-changed", ())
        .map_err(|error| error.to_string())?;
    Ok(created)
}

// 위젯 창은 키보드 입력을 받지 않으므로 일정 입력은 별도 창에서 받습니다.
// Windows에서 동기 명령으로 창을 만들면 교착될 수 있어 async로 둡니다.
#[tauri::command]
async fn open_event_editor(app: AppHandle, date: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(EDITOR_LABEL) {
        return window.set_focus().map_err(|error| error.to_string());
    }
    let date = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let url = format!("index.html?view=new-event&date={date}");
    WebviewWindowBuilder::new(&app, EDITOR_LABEL, WebviewUrl::App(url.into()))
        .title("일정 추가")
        .inner_size(420.0, 400.0)
        .resizable(false)
        .center()
        .always_on_top(true)
        .focused(true)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `tauri dev`는 src-tauri에서 실행되므로 리포지토리 루트의 파일을 읽습니다.
    let _ = dotenvy::from_filename("../.env.local");

    if !single_instance::acquire() {
        return;
    }

    let app = tauri::Builder::default()
        .manage(WidgetState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .on_window_event(|window, event| {
            if window.label() != MAIN_LABEL {
                return;
            }
            let app = window.app_handle();
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_position_save(app),
                // 맨 앞 상태로 배율이 다른 모니터에 옮겨도 같은 크기로 보이게 합니다.
                WindowEvent::ScaleFactorChanged { .. } => {
                    if let Some(webview) = app.get_webview_window(MAIN_LABEL) {
                        let summoned = app.state::<WidgetState>().summoned.load(Ordering::SeqCst);
                        apply_zoom(&webview, summoned);
                    }
                }
                WindowEvent::Destroyed => {
                    if !app.state::<WidgetState>().quitting.load(Ordering::SeqCst) {
                        restart_when_desktop_returns(app);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // 자동 실행 때는 작업 폴더가 달라 리포지토리의 파일을 찾을 수 없습니다.
            if let Ok(config_dir) = app.path().app_config_dir() {
                let _ = dotenvy::from_path(config_dir.join(ENV_FILE));
            }

            app.manage(EventCache::new(
                app.path().app_local_data_dir()?.join(EVENT_CACHE_FILE),
            ));

            let was_maximized = restore_position(app.handle()).unwrap_or(false);
            if desktop_pin::desktop_ready() {
                place_initially(app.handle(), was_maximized);
            } else {
                // 로그인 직후에는 바탕화면 창이 아직 없을 수 있습니다.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    wait_for_desktop();
                    let main_thread_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        place_initially(&main_thread_handle, was_maximized);
                    });
                });
            }

            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyK);

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, pressed, event| {
                        if pressed == &shortcut && event.state() == ShortcutState::Pressed {
                            if let Err(error) = toggle_summoned(app) {
                                eprintln!("위젯 전환 실패: {error}");
                            }
                        }
                    })
                    .build(),
            )?;

            // 다른 앱이 단축키를 쓰고 있어도 위젯은 실행되도록 오류를 화면에 표시합니다.
            if let Err(error) = app.global_shortcut().register(shortcut) {
                let state = app.state::<WidgetState>();
                *state.shortcut_error.lock().unwrap() = Some(error.to_string());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            widget_status,
            quit,
            toggle_maximized,
            autostart_enabled,
            set_autostart,
            provider_status,
            connect,
            cached_events,
            fetch_events,
            create_google_event,
            open_event_editor
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // 마지막 창이 사라져도 재시작이 끝날 때까지 프로세스를 유지합니다.
        if let RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<WidgetState>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placement_reads_old_and_new_formats() {
        let old: Placement = serde_json::from_str("[-1200,300]").unwrap();
        assert_eq!((old.x, old.y), (-1200, 300));
        assert_eq!(old.width, None);
        assert!(!old.maximized);

        let new: Placement =
            serde_json::from_str(r#"{"x":10,"y":20,"width":900,"height":620,"maximized":true}"#)
                .unwrap();
        assert_eq!((new.width, new.height), (Some(900), Some(620)));
        assert!(new.maximized);
    }
}
