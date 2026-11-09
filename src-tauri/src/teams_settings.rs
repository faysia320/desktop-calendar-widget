use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SavedChannel {
    pub url: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSettings {
    pub channels: Vec<SavedChannel>,
    pub active_id: String,
}

pub struct ChannelStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl ChannelStore {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Mutex::new(()) } }

    pub fn load(&self) -> Result<Option<ChannelSettings>, String> {
        let _guard = self.lock.lock().map_err(|_| "채널 설정을 읽을 수 없습니다.")?;
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map(Some)
                .map_err(|_| "저장된 채널 설정을 읽을 수 없습니다. 기존 파일은 보존됩니다.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("채널 설정 파일에 접근할 수 없습니다. 다시 시도해 주세요.".into()),
        }
    }

    pub fn save(&self, settings: &ChannelSettings) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "채널 설정을 저장할 수 없습니다.")?;
        if settings.channels.len() > 100 || settings.active_id.len() > 2048
            || settings.channels.iter().any(|channel| channel.url.len() > 8192 || channel.name.chars().count() > 80)
        { return Err("저장할 채널 설정이 너무 큽니다.".into()); }
        let save = || -> Result<(), Box<dyn std::error::Error>> {
            fs::create_dir_all(self.path.parent().ok_or("missing settings directory")?)?;
            let temporary = self.path.with_extension("tmp");
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&serde_json::to_vec(settings)?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(temporary, &self.path)?;
            Ok(())
        };
        save().map_err(|_| "채널 설정을 저장하지 못했습니다. 변경 전 목록을 유지합니다. 다시 시도해 주세요.".into())
    }
}

#[tauri::command]
pub fn teams_load_channels(store: State<'_, ChannelStore>) -> Result<Option<ChannelSettings>, String> {
    store.load()
}

#[tauri::command]
pub fn teams_save_channels(store: State<'_, ChannelStore>, settings: ChannelSettings) -> Result<(), String> {
    store.save(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> PathBuf {
        std::env::temp_dir().join(format!("widget-channels-test-{}-{}", std::process::id(), rand::random::<u64>())).join("teams-channels.json")
    }

    fn settings() -> ChannelSettings {
        ChannelSettings { channels: vec![SavedChannel { url: "https://teams.microsoft.com/l/channel/19%3Atest/Test?groupId=12345678-1234-1234-1234-123456789abc".into(), name: "개발 채널".into() }], active_id: "selected-channel".into() }
    }

    #[test]
    fn channels_and_selection_survive_reopening_store_and_explicit_removal() {
        let path = path();
        let store = ChannelStore::new(path.clone());
        assert_eq!(store.load().unwrap(), None);
        store.save(&settings()).unwrap();
        drop(store);
        let reopened = ChannelStore::new(path.clone());
        assert_eq!(reopened.load().unwrap(), Some(settings()));
        let empty = ChannelSettings { channels: vec![], active_id: String::new() };
        reopened.save(&empty).unwrap();
        assert_eq!(ChannelStore::new(path.clone()).load().unwrap(), Some(empty));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn unreadable_settings_are_not_treated_as_an_empty_list() {
        let path = path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"broken json").unwrap();
        assert!(ChannelStore::new(path.clone()).load().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken json");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn failed_save_keeps_the_previous_file() {
        let path = path();
        let store = ChannelStore::new(path.clone());
        store.save(&settings()).unwrap();
        fs::create_dir(path.with_extension("tmp")).unwrap();
        assert!(store.save(&ChannelSettings { channels: vec![], active_id: String::new() }).is_err());
        assert_eq!(store.load().unwrap(), Some(settings()));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
