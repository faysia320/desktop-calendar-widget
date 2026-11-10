mod desktop_pin;
mod event_cache;
mod news;
mod oauth;
mod single_instance;
mod teams;
mod teams_settings;
mod teams_read;
mod teams_notifications;
mod link_preview;
mod appearance;

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chrono::NaiveDate;
use event_cache::{CachedEvents, EventCache};
use oauth::{CalendarEvent, GoogleCalendar, NewEvent, Provider, ProviderStatus};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use windows_sys::Win32::Foundation::RECT;

const MAIN_LABEL: &str = "main";
const EDITOR_LABEL: &str = "event-editor";
const EDITOR_OPEN_EVENT: &str = "event-editor-open";
const EDITOR_WIDTH: f64 = 420.0;
const EDITOR_HEIGHT: f64 = 470.0;
const ENV_FILE: &str = ".env.local";
const POSITION_FILE: &str = "window-position.json";
const EVENT_CACHE_FILE: &str = "event-cache.json";
const HOLIDAY_CACHE_FILE: &str = "holiday-cache.json";
const ROOM_CACHE_FILE: &str = "room-cache.json";
const NEWS_CACHE_FILE: &str = "news-cache.json";
const POSITION_SAVE_DELAY: Duration = Duration::from_millis(500);
// 창 왼쪽 위 모서리만 걸친 위치로 복원되어 위젯을 잡을 수 없게 되는 것을 막습니다.
const MIN_VISIBLE_PX: i32 = 100;
const DESKTOP_WAIT_TIMEOUT: Duration = Duration::from_secs(60);
const DESKTOP_POLL_INTERVAL: Duration = Duration::from_millis(500);
// Explorer가 Progman을 만든 직후에는 자식 창이 아직 준비되지 않아 잠시 기다립니다.
const DESKTOP_SETTLE_DELAY: Duration = Duration::from_secs(2);
const PAGE_START_TIMEOUT: Duration = Duration::from_secs(30);
const MONITOR_POLL_INTERVAL: Duration = Duration::from_secs(2);
const TRAY_SHOW_ID: &str = "show";
const TRAY_QUIT_ID: &str = "quit";

// 일정 캐시의 용량을 차지하지 않도록 공휴일은 별도 파일에 Google 항목으로 저장합니다.
struct HolidayCache(EventCache);

struct RoomCache(EventCache);

struct NewsCache(std::path::PathBuf);

#[derive(Default)]
struct WidgetState {
    summoned: AtomicBool,
    quitting: AtomicBool,
    position_save_generation: AtomicU64,
    // 최대화 중일 때만 값이 있으며, 되돌아갈 화면 기준 위치와 크기입니다.
    normal_rect: Mutex<Option<RECT>>,
    shortcut_error: Mutex<Option<String>>,
    page_started: AtomicBool,
    // 위젯이 따라간 마지막 모니터 배치입니다.
    layout: Mutex<Option<DisplayLayout>>,
    // 저장된 모니터가 빠져 다른 모니터에 임시로 옮겨 둔 상태입니다.
    away_from_home: AtomicBool,
}

#[derive(Clone, PartialEq)]
struct MonitorBox {
    name: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl MonitorBox {
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

// 바탕화면 창은 모니터보다 늦게 바뀌고 자식 창의 좌표 기준이므로 함께 비교합니다.
#[derive(Clone, PartialEq)]
struct DisplayLayout {
    monitors: Vec<MonitorBox>,
    desktop: Option<(i32, i32, i32, i32)>,
}

impl DisplayLayout {
    fn read(window: &WebviewWindow) -> Option<Self> {
        let monitors: Vec<MonitorBox> = window
            .available_monitors()
            .ok()?
            .iter()
            .map(|monitor| MonitorBox {
                name: monitor.name().cloned().unwrap_or_default(),
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width as i32,
                height: monitor.size().height as i32,
            })
            .collect();
        (!monitors.is_empty()).then_some(Self {
            monitors,
            desktop: desktop_pin::desktop_rect(),
        })
    }
}

/// 저장할 때 위젯이 있던 모니터와 그 모니터의 당시 위치입니다.
#[derive(Serialize, Deserialize)]
struct MonitorAnchor {
    name: String,
    x: i32,
    y: i32,
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
    #[serde(default)]
    monitor: Option<MonitorAnchor>,
}

impl Placement {
    /// 모니터 배치가 바뀌면 같은 모니터의 좌표도 달라지므로 그 모니터의 현재 위치로 옮겨 돌려줍니다.
    fn home_position(&self, monitors: &[MonitorBox]) -> Option<(i32, i32)> {
        let anchor = self.monitor.as_ref()?;
        let monitor = monitors.iter().find(|monitor| monitor.name == anchor.name)?;
        Some((
            (self.x - anchor.x + monitor.x).clamp(monitor.x, monitor.x + monitor.width - MIN_VISIBLE_PX),
            (self.y - anchor.y + monitor.y).clamp(monitor.y, monitor.y + monitor.height - MIN_VISIBLE_PX),
        ))
    }
}

/// 크기를 영역 안으로 줄이고 영역을 벗어나지 않게 옮깁니다.
fn fit_rect(rect: RECT, area: RECT) -> RECT {
    let width = (rect.right - rect.left).min(area.right - area.left);
    let height = (rect.bottom - rect.top).min(area.bottom - area.top);
    let left = rect.left.clamp(area.left, area.right - width);
    let top = rect.top.clamp(area.top, area.bottom - height);
    RECT {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

fn position_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(POSITION_FILE))
}

fn read_placement(app: &AppHandle) -> Option<Placement> {
    let saved = std::fs::read(position_path(app)?).ok()?;
    serde_json::from_slice(&saved).ok()
}

fn save_position(app: &AppHandle) -> Option<()> {
    let window = app.get_webview_window(MAIN_LABEL)?;
    let state = app.state::<WidgetState>();
    // 임시 위치나 배치가 바뀌는 중의 위치가 사용자가 둔 위치를 덮어쓰면 안 됩니다.
    let layout = DisplayLayout::read(&window)?;
    if state.away_from_home.load(Ordering::SeqCst)
        || state.layout.lock().unwrap().as_ref() != Some(&layout)
    {
        return None;
    }
    let normal_rect = *state.normal_rect.lock().unwrap();
    let rect = match normal_rect {
        Some(rect) => rect,
        None => desktop_pin::screen_rect(&window)?,
    };
    let (center_x, center_y) = ((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    let placement = Placement {
        x: rect.left,
        y: rect.top,
        width: Some(rect.right - rect.left),
        height: Some(rect.bottom - rect.top),
        maximized: normal_rect.is_some(),
        monitor: layout
            .monitors
            .iter()
            .find(|monitor| monitor.contains(center_x, center_y))
            .map(|monitor| MonitorAnchor {
                name: monitor.name.clone(),
                x: monitor.x,
                y: monitor.y,
            }),
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
    let placement = read_placement(app)?;
    let monitors = DisplayLayout::read(&window)?.monitors;
    let (x, y) = match placement.home_position(&monitors) {
        Some(position) => position,
        // 저장할 때 쓰던 모니터가 빠졌으면 기본 위치에 두고, 다시 꽂으면 돌아갑니다.
        None if placement.monitor.is_some() => {
            app.state::<WidgetState>().away_from_home.store(true, Ordering::SeqCst);
            return Some(placement.maximized);
        }
        None if monitors
            .iter()
            .any(|monitor| monitor.contains(placement.x + MIN_VISIBLE_PX, placement.y + MIN_VISIBLE_PX)) =>
        {
            (placement.x, placement.y)
        }
        None => return Some(false),
    };
    window.set_position(PhysicalPosition::new(x, y)).ok()?;
    if let (Some(width), Some(height)) = (placement.width, placement.height) {
        window
            .set_size(PhysicalSize::new(width as u32, height as u32))
            .ok()?;
    }
    Some(placement.maximized)
}

/// 저장된 모니터가 있으면 그곳으로, 없으면 보이는 모니터로 위젯을 옮깁니다. 최대화 상태는 유지합니다.
fn follow_monitors(app: &AppHandle) -> Option<()> {
    let window = app.get_webview_window(MAIN_LABEL)?;
    let state = app.state::<WidgetState>();
    let layout = DisplayLayout::read(&window)?;
    let monitors = layout.monitors.clone();
    *state.layout.lock().unwrap() = Some(layout);

    let mut normal_rect = state.normal_rect.lock().unwrap();
    let current = match *normal_rect {
        Some(rect) => rect,
        None => desktop_pin::screen_rect(&window)?,
    };
    let (width, height) = (current.right - current.left, current.bottom - current.top);
    let at = |x: i32, y: i32| RECT {
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
    };

    let placement = read_placement(app);
    let home = placement.as_ref().and_then(|placement| placement.home_position(&monitors));
    let away = home.is_none() && placement.is_some_and(|placement| placement.monitor.is_some());
    state.away_from_home.store(away, Ordering::SeqCst);

    let wanted = match home {
        Some((x, y)) => at(x, y),
        None if monitors
            .iter()
            .any(|monitor| monitor.contains(current.left + MIN_VISIBLE_PX, current.top + MIN_VISIBLE_PX)) =>
        {
            current
        }
        None => {
            let primary = window.primary_monitor().ok().flatten()?;
            at(primary.position().x, primary.position().y)
        }
    };
    let area = desktop_pin::work_area_of(wanted)?;
    let normal = fit_rect(wanted, area);
    if normal_rect.is_some() {
        desktop_pin::move_to(&window, area).ok()?;
        *normal_rect = Some(normal);
    } else {
        desktop_pin::move_to(&window, normal).ok()?;
    }
    Some(())
}

// 실행 중에 모니터 배치가 바뀌면 위젯이 바탕화면 밖에 남아 보이지 않게 됩니다.
fn watch_monitors(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut previous = None;
        loop {
            std::thread::sleep(MONITOR_POLL_INTERVAL);
            let Some(layout) = app
                .get_webview_window(MAIN_LABEL)
                .and_then(|window| DisplayLayout::read(&window))
            else {
                continue;
            };
            // 선을 꽂는 동안에는 배치가 여러 번 바뀌므로 같은 값이 연달아 읽힐 때만 따라갑니다.
            let settled = previous.as_ref() == Some(&layout);
            let changed = app.state::<WidgetState>().layout.lock().unwrap().as_ref() != Some(&layout);
            previous = Some(layout);
            if settled && changed {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    follow_monitors(&handle);
                });
            }
        }
    });
}

// 트레이에서 부를 때는 어디에 있든 보이도록 먼저 화면 안으로 옮깁니다.
fn summon_from_tray(app: &AppHandle) {
    follow_monitors(app);
    if let Err(error) = toggle_summoned(app) {
        eprintln!("위젯 전환 실패: {error}");
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "위젯 보이기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip("캘린더 위젯")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => {
                if !app.state::<WidgetState>().summoned.load(Ordering::SeqCst) {
                    summon_from_tray(app);
                }
            }
            TRAY_QUIT_ID => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                summon_from_tray(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
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
    // 시작할 때는 이동 이벤트가 오지 않을 수 있어, 예전 파일에도 모니터 정보가 남도록 직접 저장합니다.
    schedule_position_save(app);
}

// WebView2가 내장 페이지 응답을 받지 못하면 빈 투명 창으로 남고 새로고침으로도 복구되지 않습니다.
// 원인을 찾기 전까지 앱을 새로 실행해 복구합니다.
fn restart_if_page_never_starts(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PAGE_START_TIMEOUT);
        let state = app.state::<WidgetState>();
        if !state.page_started.load(Ordering::SeqCst) && !state.quitting.load(Ordering::SeqCst) {
            single_instance::release();
            app.restart();
        }
    });
}

#[derive(Serialize)]
struct WidgetStatus {
    maximized: bool,
    shortcut_error: Option<String>,
    rooms: Vec<String>,
}

/// 단축키로 불렀으면 맨 위에, 그 외에는 바탕화면에 둡니다.
fn place_window(app: &AppHandle, summoned: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| tauri::Error::WindowNotFound.to_string())?;

    // Allow keyboard input in both modes. Apply Tao's window styles before
    // reparenting: changing them afterwards can overwrite WS_CHILD/WS_EX_LAYERED.
    window.set_focusable(true).map_err(|error| error.to_string())?;
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

// Focus WebView2 itself (MoveFocus), not the top-level window. Window::set_focus
// brings a window forward; text input must not change the desktop parent or mode.
#[tauri::command]
fn focus_widget_input(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(MAIN_LABEL).ok_or("위젯 입력 화면을 찾을 수 없습니다.")?
        .as_ref().set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn widget_status(state: State<'_, WidgetState>) -> WidgetStatus {
    state.page_started.store(true, Ordering::SeqCst);
    WidgetStatus {
        maximized: state.normal_rect.lock().unwrap().is_some(),
        shortcut_error: state.shortcut_error.lock().unwrap().clone(),
        rooms: oauth::room_names(),
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

fn quit_app(app: &AppHandle) {
    app.state::<WidgetState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn quit(app: AppHandle) {
    quit_app(&app);
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

// 공휴일은 부가 정보라 받아 오지 못하면 저장된 값을 보여 주고 오류는 띄우지 않습니다.
#[tauri::command]
async fn holidays(
    cache: State<'_, HolidayCache>,
    from: String,
    to: String,
) -> Result<Vec<CalendarEvent>, String> {
    match oauth::fetch_holidays(&from, &to).await {
        Ok(holidays) => {
            if let Err(error) = cache.0.store(Provider::Google, &from, &to, holidays.clone()) {
                eprintln!("공휴일 캐시 저장 실패: {error}");
            }
            Ok(holidays)
        }
        Err(error) => {
            eprintln!("공휴일 조회 실패: {error}");
            Ok(cache
                .0
                .load(Provider::Google, &from, &to)
                .map(|cached| cached.into_events())
                .unwrap_or_default())
        }
    }
}

// 회의실도 부가 정보라 공휴일처럼 저장된 값으로 대신합니다.
#[tauri::command]
async fn rooms(
    cache: State<'_, RoomCache>,
    from: String,
    to: String,
) -> Result<Vec<CalendarEvent>, String> {
    match oauth::fetch_rooms(&from, &to).await {
        Ok(bookings) => {
            if let Err(error) = cache.0.store(Provider::Microsoft, &from, &to, bookings.clone()) {
                eprintln!("회의실 캐시 저장 실패: {error}");
            }
            Ok(bookings)
        }
        Err(error) => {
            eprintln!("회의실 일정 조회 실패: {error}");
            Ok(cache
                .0
                .load(Provider::Microsoft, &from, &to)
                .map(|cached| cached.into_events())
                .unwrap_or_default())
        }
    }
}

#[tauri::command]
async fn geeknews(cache: State<'_, NewsCache>) -> Result<news::NewsFeed, String> {
    news::fetch(&cache.0).await
}

#[tauri::command]
fn open_article(app: AppHandle, url: String) -> Result<(), String> {
    if !news::is_article_url(&url) {
        return Err("GeekNews 글 주소가 아닙니다.".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("브라우저를 열 수 없습니다: {error}"))
}

#[tauri::command]
async fn google_calendars() -> Result<Vec<GoogleCalendar>, String> {
    oauth::google_calendars().await
}

#[tauri::command]
async fn create_google_event(app: AppHandle, event: NewEvent) -> Result<CalendarEvent, String> {
    let created = oauth::create_google_event(&event).await?;
    app.emit("events-changed", ())
        .map_err(|error| error.to_string())?;
    Ok(created)
}

#[tauri::command]
async fn google_event(calendar_id: String, event_id: String) -> Result<CalendarEvent, String> {
    oauth::google_event(&calendar_id, &event_id).await
}

#[tauri::command]
async fn update_google_event(
    app: AppHandle,
    event_id: String,
    event: NewEvent,
) -> Result<CalendarEvent, String> {
    let updated = oauth::update_google_event(&event_id, &event).await?;
    app.emit("events-changed", ())
        .map_err(|error| error.to_string())?;
    Ok(updated)
}

#[tauri::command]
async fn delete_google_event(
    app: AppHandle,
    calendar_id: String,
    event_id: String,
) -> Result<(), String> {
    oauth::delete_google_event(&calendar_id, &event_id).await?;
    app.emit("events-changed", ())
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorTarget {
    calendar_id: String,
    event_id: String,
}

// 위젯 가운데에 위젯과 같은 배율로 두되, 위젯이 작아도 모니터 밖으로 나가지 않게 합니다.
// 배율이 다른 모니터로 옮기면 창 크기도 바뀌므로 먼저 그 모니터로 옮긴 뒤 크기를 정합니다.
fn place_editor_over_widget(app: &AppHandle, window: &WebviewWindow) -> Option<()> {
    let widget = app.get_webview_window(MAIN_LABEL)?;
    let rect = desktop_pin::screen_rect(&widget)?;
    let area = desktop_pin::work_area(&widget)?;
    window
        .set_position(PhysicalPosition::new(area.left, area.top))
        .ok()?;
    let zoom = desktop_pin::floating_zoom(window);
    window.set_zoom(zoom).ok()?;
    window
        .set_size(LogicalSize::new(EDITOR_WIDTH * zoom, EDITOR_HEIGHT * zoom))
        .ok()?;
    let size = window.outer_size().ok()?;
    let (width, height) = (size.width as i32, size.height as i32);
    let x = (rect.left + (rect.right - rect.left - width) / 2)
        .min(area.right - width)
        .max(area.left);
    let y = (rect.top + (rect.bottom - rect.top - height) / 2)
        .min(area.bottom - height)
        .max(area.top);
    window.set_position(PhysicalPosition::new(x, y)).ok()
}

// 어두워진 위젯을 누르면 다이얼로그를 다시 앞으로 가져옵니다.
#[tauri::command]
async fn focus_event_editor(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(EDITOR_LABEL)
        .ok_or_else(|| tauri::Error::WindowNotFound.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

// 위젯 창은 키보드 입력을 받지 않으므로 일정 입력은 별도 창에서 받습니다.
// Windows에서 동기 명령으로 창을 만들면 교착될 수 있어 async로 둡니다.
#[tauri::command]
async fn open_event_editor(
    app: AppHandle,
    date: String,
    target: Option<EditorTarget>,
) -> Result<(), String> {
    let date = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|error| error.to_string())?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("date", &date.to_string());
    let title = match &target {
        Some(target) => {
            query
                .append_pair("view", "edit-event")
                .append_pair("calendarId", &target.calendar_id)
                .append_pair("eventId", &target.event_id);
            "일정 편집"
        }
        None => {
            query.append_pair("view", "new-event");
            "일정 추가"
        }
    };
    let query = query.finish();

    // 다른 일정을 고르면 열려 있는 창의 내용을 그 일정으로 바꿉니다.
    if let Some(window) = app.get_webview_window(EDITOR_LABEL) {
        let mut url = window.url().map_err(|error| error.to_string())?;
        if url.query() != Some(query.as_str()) {
            url.set_query(Some(&query));
            window.navigate(url).map_err(|error| error.to_string())?;
            window.set_title(title).map_err(|error| error.to_string())?;
        }
        return window.set_focus().map_err(|error| error.to_string());
    }
    let url = format!("index.html?{query}");
    let window = WebviewWindowBuilder::new(&app, EDITOR_LABEL, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(EDITOR_WIDTH, EDITOR_HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .visible(false)
        .always_on_top(true)
        .focused(true)
        .build()
        .map_err(|error| error.to_string())?;
    place_editor_over_widget(&app, &window);
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    app.emit(EDITOR_OPEN_EVENT, true)
        .map_err(|error| error.to_string())
}

pub fn run(context: tauri::Context<tauri::Wry>) {
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
            if window.label() == EDITOR_LABEL {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = window.app_handle().emit(EDITOR_OPEN_EVENT, false);
                }
                return;
            }
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
            app.manage(HolidayCache(EventCache::new(
                app.path().app_local_data_dir()?.join(HOLIDAY_CACHE_FILE),
            )));
            app.manage(RoomCache(EventCache::new(
                app.path().app_local_data_dir()?.join(ROOM_CACHE_FILE),
            )));
            app.manage(NewsCache(app.path().app_local_data_dir()?.join(NEWS_CACHE_FILE)));
            app.manage(appearance::AppearanceStore::new(app.path().app_config_dir()?.join("appearance.json")));
            app.manage(teams::TeamsSession::default());
            app.manage(link_preview::PreviewStore::default());
            app.manage(teams_read::ReadStore::new(app.path().app_config_dir()?.join("teams-read-marks.json")));
            app.manage(teams_notifications::MentionStore::new(app.path().app_config_dir()?.join("teams-mentions.json")));
            app.manage(teams_settings::ChannelStore::new(
                app.path().app_config_dir()?.join("teams-channels.json"),
            ));

            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                *app.state::<WidgetState>().layout.lock().unwrap() = DisplayLayout::read(&window);
            }
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
            restart_if_page_never_starts(app.handle());
            watch_monitors(app.handle());
            // 트레이 아이콘이 없어도 위젯은 쓸 수 있으므로 실행을 막지 않습니다.
            if let Err(error) = build_tray(app.handle()) {
                eprintln!("트레이 아이콘 생성 실패: {error}");
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
            focus_widget_input,
            teams::teams_status,
            teams_read::teams_load_read_marks,
            teams_read::teams_mark_read,
            teams_settings::teams_load_channels,
            teams_settings::teams_save_channels,
            appearance::load_transparency,
            appearance::save_transparency,
            teams::teams_connect,
            teams::teams_messages,
            teams_notifications::teams_observe_mentions,
            teams_notifications::teams_observe_chats,
            teams::teams_members,
            teams::teams_send,
            teams::teams_react,
            teams::teams_hosted_image,
            teams::teams_chats,
            teams::teams_joined_channels,
            teams::teams_open,
            teams::teams_open_message_url,
            link_preview::teams_link_preview,
            connect,
            cached_events,
            fetch_events,
            holidays,
            rooms,
            geeknews,
            open_article,
            google_calendars,
            create_google_event,
            google_event,
            update_google_event,
            delete_google_event,
            open_event_editor,
            focus_event_editor
        ])
        .build(context)
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

    fn monitor(name: &str, x: i32, y: i32, width: i32, height: i32) -> MonitorBox {
        MonitorBox {
            name: name.to_string(),
            x,
            y,
            width,
            height,
        }
    }

    fn placement_on(name: &str, x: i32, y: i32, anchor_x: i32, anchor_y: i32) -> Placement {
        Placement {
            x,
            y,
            width: Some(1049),
            height: Some(1361),
            maximized: true,
            monitor: Some(MonitorAnchor {
                name: name.to_string(),
                x: anchor_x,
                y: anchor_y,
            }),
        }
    }

    #[test]
    fn home_position_follows_the_monitor_when_the_layout_changes() {
        let placement = placement_on("DISPLAY2", 3862, 346, 3840, 235);
        let moved = [monitor("DISPLAY1", 0, 0, 2560, 1440), monitor("DISPLAY2", -1080, 0, 1080, 1920)];
        assert_eq!(placement.home_position(&moved), Some((-1058, 111)));
    }

    #[test]
    fn home_position_is_missing_while_the_monitor_is_unplugged() {
        let placement = placement_on("DISPLAY2", 3862, 346, 3840, 235);
        assert_eq!(placement.home_position(&[monitor("DISPLAY1", 0, 0, 2560, 1440)]), None);
    }

    #[test]
    fn home_position_stays_on_a_monitor_that_became_smaller() {
        let placement = placement_on("DISPLAY1", 3000, 2000, 0, 0);
        let smaller = [monitor("DISPLAY1", 0, 0, 1920, 1080)];
        assert_eq!(
            placement.home_position(&smaller),
            Some((1920 - MIN_VISIBLE_PX, 1080 - MIN_VISIBLE_PX))
        );
    }

    #[test]
    fn fit_rect_keeps_the_window_inside_the_area() {
        let area = RECT { left: 0, top: 0, right: 1000, bottom: 800 };
        let fitted = fit_rect(RECT { left: 900, top: -50, right: 2100, bottom: 350 }, area);
        assert_eq!(
            (fitted.left, fitted.top, fitted.right, fitted.bottom),
            (0, 0, 1000, 400)
        );
    }
}
