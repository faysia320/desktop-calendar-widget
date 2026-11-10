use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Deserialize, Serialize)]
struct Settings { transparency: u8 }

pub struct AppearanceStore { path: PathBuf, lock: Mutex<()> }
impl AppearanceStore {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Mutex::new(()) } }
    fn load(&self) -> Result<Option<u8>, String> {
        let _guard = self.lock.lock().map_err(|_| "표시 설정 잠금 실패")?;
        match fs::read(&self.path) {
            Ok(bytes) => {
                let settings: Settings = serde_json::from_slice(&bytes)
                    .map_err(|_| "투명도 설정을 읽지 못했습니다. 기존 파일은 보존됩니다.")?;
                if settings.transparency > 100 { return Err("저장된 투명도 범위가 올바르지 않습니다.".into()); }
                Ok(Some(settings.transparency))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("투명도 설정 파일에 접근할 수 없습니다.".into()),
        }
    }
    fn save(&self, transparency: u8) -> Result<(), String> {
        if transparency > 100 { return Err("투명도는 0~100%로 설정해 주세요.".into()); }
        let _guard = self.lock.lock().map_err(|_| "표시 설정 잠금 실패")?;
        let save = || -> Result<(), Box<dyn std::error::Error>> {
            fs::create_dir_all(self.path.parent().ok_or("Missing directory")?)?;
            let temporary = self.path.with_extension("tmp");
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&serde_json::to_vec(&Settings { transparency })?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(temporary, &self.path)?;
            Ok(())
        };
        save().map_err(|_| "투명도를 저장하지 못했습니다. 다시 설정해 주세요.".into())
    }
}

#[tauri::command]
pub fn load_transparency(store: State<'_, AppearanceStore>) -> Result<Option<u8>, String> { store.load() }
#[tauri::command]
pub fn save_transparency(store: State<'_, AppearanceStore>, transparency: u8) -> Result<(), String> { store.save(transparency) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zero_and_extremes_survive_reopening_and_failed_writes_preserve_settings() {
        let directory = std::env::temp_dir().join(format!("widget-appearance-{}", rand::random::<u64>()));
        let path = directory.join("appearance.json");
        let store = AppearanceStore::new(path.clone());
        assert_eq!(store.load().unwrap(), None);
        for value in [15, 100, 0] {
            store.save(value).unwrap();
            assert_eq!(AppearanceStore::new(path.clone()).load().unwrap(), Some(value));
        }
        assert!(store.save(101).is_err());
        fs::create_dir(path.with_extension("tmp")).unwrap();
        assert!(store.save(15).is_err());
        assert_eq!(store.load().unwrap(), Some(0));
        fs::write(&path, b"broken").unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(directory).unwrap();
    }
}
