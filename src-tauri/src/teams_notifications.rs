use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Mutex};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Deserialize, Serialize)]
pub struct Mention { pub id: String, pub time: i64 }

#[derive(Default, Deserialize, Serialize)]
struct ChannelState {
    // First observation is the opt-in boundary, not the last message timestamp.
    since: i64,
    seen: BTreeMap<String, i64>,
}
type Records = BTreeMap<String, ChannelState>;
pub struct MentionStore { path: PathBuf, lock: Mutex<()> }
impl MentionStore {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Mutex::new(()) } }
    fn observe(&self, key: String, mentions: &[Mention], now: i64) -> Result<usize, String> {
        let _guard = self.lock.lock().map_err(|_| "멘션 알림 기록 잠금 실패")?;
        let mut records: Records = match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "멘션 알림 기록을 읽지 못했습니다. 기존 파일은 보존됩니다.")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(_) => return Err("멘션 알림 기록에 접근할 수 없습니다.".into()),
        };
        let first = !records.contains_key(&key);
        let state = records.entry(key).or_insert_with(|| ChannelState { since: now, seen: BTreeMap::new() });
        // Bounded seven-day catch-up; old history/pages cannot become new notifications.
        let cutoff = state.since.max(now - 7 * 86_400_000);
        let old_len = state.seen.len();
        state.seen.retain(|_, time| *time >= cutoff);
        let mut changed = first || state.seen.len() != old_len;
        let mut count = 0;
        for mention in mentions {
            if mention.time <= cutoff || mention.time > now + 60_000 || mention.id.is_empty()
                || mention.id.len() > 512 || state.seen.contains_key(&mention.id) { continue; }
            state.seen.insert(mention.id.clone(), mention.time);
            changed = true;
            if !first { count += 1; }
        }
        if changed {
            let save = || -> Result<(), Box<dyn std::error::Error>> {
                fs::create_dir_all(self.path.parent().ok_or("missing directory")?)?;
                let temporary = self.path.with_extension("tmp");
                let mut file = fs::File::create(&temporary)?;
                file.write_all(&serde_json::to_vec(&records)?)?;
                file.sync_all()?;
                drop(file);
                fs::rename(temporary, &self.path)?;
                Ok(())
            };
            save().map_err(|_| "멘션 알림 기록을 저장하지 못했습니다.".to_string())?;
        }
        Ok(count)
    }
}

fn xml(value: &str) -> String {
    value.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect::<String>().replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&apos;")
}

fn register_shortcut() -> Result<(), String> {
    use windows::{core::{HSTRING, Interface}, Win32::{
        System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED, IPersistFile, STGM_READWRITE, StructuredStorage::PROPVARIANT},
        Storage::EnhancedStorage::PKEY_AppUserModel_ID,
        UI::Shell::{IShellLinkW, ShellLink, PropertiesSystem::{IPropertyStore, PSCoerceToCanonicalValue}},
    }};
    static REGISTERED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if REGISTERED.get().is_some() { return Ok(()); }
    let mut executable = std::env::current_exe().map_err(|_| "위젯 실행 파일 위치 확인 실패")?;
    if cfg!(test) {
        executable = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA 없음")?)
            .join("Programs/desktop-calendar-widget/desktop-calendar-widget.exe");
    }
    let directory = PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA 없음")?)
        .join("Microsoft/Windows/Start Menu/Programs");
    fs::create_dir_all(&directory).map_err(|_| "시작 메뉴 폴더 접근 실패")?;
    let shortcut = directory.join("캘린더 위젯.lnk");
    let setup = || -> windows::core::Result<()> { unsafe {
        // A sync Tauri command may run in an existing STA or MTA. Balance only
        // successful initializations; RPC_E_CHANGED_MODE means COM already exists.
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialized.is_err() && initialized.0 != 0x80010106u32 as i32 { initialized.ok()?; }
        struct Apartment(bool);
        impl Drop for Apartment { fn drop(&mut self) { if self.0 { unsafe { CoUninitialize(); } } } }
        let _apartment = Apartment(initialized.is_ok());
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        let path = HSTRING::from(shortcut.as_os_str());
        if shortcut.exists() {
            file.Load(&path, STGM_READWRITE)?;
            let mut target = [0u16; 32768];
            link.GetPath(&mut target, std::ptr::null_mut(), 0)?;
            let end = target.iter().position(|c| *c == 0).unwrap_or(target.len());
            let existing = PathBuf::from(String::from_utf16_lossy(&target[..end]));
            if existing != executable {
                return Err(windows::core::Error::new(windows::core::HRESULT(0x80070050u32 as i32), "다른 앱의 바로 가기는 변경하지 않습니다."));
            }
        } else {
            link.SetPath(&HSTRING::from(executable.as_os_str()))?;
            link.SetDescription(&HSTRING::from("캘린더 위젯"))?;
        }
        let properties: IPropertyStore = link.cast()?;
        let mut id = PROPVARIANT::from("com.rocket.desktopcalendarwidget");
        PSCoerceToCanonicalValue(&PKEY_AppUserModel_ID, &mut id)?;
        properties.SetValue(&PKEY_AppUserModel_ID, &id)?;
        properties.Commit()?;
        file.Save(&path, true)?;
        Ok(())
    }};
    setup().map_err(|e| format!("Windows 알림용 시작 메뉴 등록 실패 ({:08X})", e.code().0 as u32))?;
    let _ = REGISTERED.set(());
    Ok(())
}

fn show_notification(name: &str, url: &str, count: usize) -> Result<(), String> {
    use windows::{core::HSTRING, Data::Xml::Dom::XmlDocument,
        UI::Notifications::{ToastNotification, ToastNotificationManager, NotificationSetting}};
    const APP_ID: &str = "com.rocket.desktopcalendarwidget";
    register_shortcut()?;
    // This app is also distributed as a standalone EXE: register its own identity
    // instead of relying on an installer shortcut or borrowing PowerShell's identity.
    let register = || -> std::io::Result<()> {
        let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(format!(r"Software\Classes\AppUserModelId\{APP_ID}"))?;
        key.set_value("DisplayName", &"캘린더 위젯")?;
        Ok(())
    };
    register().map_err(|_| "Windows 멘션 알림을 등록하지 못했습니다.")?;
    let show = || -> windows::core::Result<()> {
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))?;
        match notifier.Setting() {
            Ok(setting) if setting != NotificationSetting::Enabled =>
                return Err(windows::core::Error::new(windows::core::HRESULT(0x80070005u32 as i32), "알림 꺼짐")),
            // Windows creates the per-app notification settings on first delivery.
            Err(error) if error.code().0 != 0x80070490u32 as i32 => return Err(error),
            _ => {},
        }
        let document = XmlDocument::new()?;
        let body = if count == 0 { "멘션 알림 연결을 확인하는 테스트 알림입니다.".to_string() }
            else { format!("나를 멘션한 새 메시지 {count}개가 있습니다.") };
        document.LoadXml(&HSTRING::from(format!(
            "<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>Teams · {}</text><text>{}</text></binding></visual></toast>",
            xml(url), xml(name), xml(&body))))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        if count == 0 {
            toast.SetTag(&HSTRING::from("mention-test"))?;
            toast.SetGroup(&HSTRING::from("tests"))?;
        }
        notifier.Show(&toast)
    };
    show().map_err(|error| format!("Windows 멘션 알림을 표시하지 못했습니다 ({:08X}). Windows 설정 → 시스템 → 알림에서 ‘캘린더 위젯’을 확인해 주세요. 채널의 @ 표시는 유지됩니다.", error.code().0 as u32))
}

#[tauri::command]
pub fn teams_observe_mentions(store: State<'_, MentionStore>, account: String, channel: String,
    name: String, url: String, mentions: Vec<Mention>) -> Result<(), String> {
    let link = url::Url::parse(&url).map_err(|_| "멘션 알림 채널 링크가 올바르지 않습니다.")?;
    if account.is_empty() || account.len() > 512 || channel.is_empty() || channel.len() > 2048
        || name.chars().count() > 80 || mentions.len() > 50_000 || link.scheme() != "https"
        || !matches!(link.host_str(), Some("teams.microsoft.com" | "teams.cloud.microsoft"))
        || !link.username().is_empty() || link.password().is_some() || link.port().is_some()
        || !(link.path().starts_with("/l/channel/") || link.path().starts_with("/l/message/")) {
        return Err("멘션 알림 정보가 올바르지 않습니다.".into());
    }
    let key = serde_json::to_string(&[account, channel]).map_err(|_| "멘션 알림 키 오류")?;
    // Persist before dispatch so a crash/restart cannot replay a batch of alerts.
    // Failed Windows delivery remains visible through the separate unread @ badge.
    let count = store.observe(key, &mentions, chrono::Utc::now().timestamp_millis())?;
    if count > 0 { show_notification(&name, &url, count)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn baselines_deduplicates_restarts_and_separates_accounts() {
        let path = std::env::temp_dir().join(format!("widget-mentions-{}", rand::random::<u64>())).join("mentions.json");
        let store = MentionStore::new(path.clone());
        let mention = |id: &str, time| Mention { id: id.into(), time };
        assert_eq!(store.observe("a:channel".into(), &[mention("old", 90)], 100).unwrap(), 0);
        assert_eq!(store.observe("a:channel".into(), &[mention("new", 200), mention("new", 200), mention("same-time", 200)], 250).unwrap(), 2);
        let restarted = MentionStore::new(path.clone());
        assert_eq!(restarted.observe("a:channel".into(), &[mention("new", 200), mention("late", 150)], 300).unwrap(), 1);
        assert_eq!(restarted.observe("b:channel".into(), &[mention("new", 200)], 300).unwrap(), 0);
        assert_eq!(restarted.observe("a:channel".into(), &[mention("history", 50)], 300).unwrap(), 0);
        assert_eq!(restarted.observe("a:other-channel".into(), &[], 300).unwrap(), 0);
        assert_eq!(restarted.observe("a:other-channel".into(), &[mention("new", 350)], 400).unwrap(), 1);
        assert_eq!(restarted.observe("a:channel".into(), &[mention("too-old", 400)], 8 * 86_400_000).unwrap(), 0);
        fs::write(&path, b"broken").unwrap();
        assert!(store.observe("a:channel".into(), &[], 400).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn notification_xml_cannot_inject_markup() {
        assert_eq!(xml("<&\"'\u{0}>"), "&lt;&amp;&quot;&apos;&gt;");
    }
    #[test]
    #[ignore = "Sends one explicitly labelled Windows notification; run manually on a desktop"]
    fn windows_notification_reaches_action_center() {
        use windows::{core::HSTRING, UI::Notifications::ToastNotificationManager};
        show_notification("알림 기능 테스트", "https://teams.microsoft.com", 0).unwrap();
        let app = HSTRING::from("com.rocket.desktopcalendarwidget");
        let history = ToastNotificationManager::History().unwrap();
        let mut found = false;
        for _ in 0..20 {
            let notifications = history.GetHistoryWithId(&app).unwrap();
            found = notifications.into_iter().any(|toast| toast.Tag().is_ok_and(|tag| tag == "mention-test"));
            if found { break; }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        assert!(found, "Windows did not retain the test toast in notification history");
        history.RemoveGroupedTagWithId(&HSTRING::from("mention-test"), &HSTRING::from("tests"), &app).unwrap();
    }
}
