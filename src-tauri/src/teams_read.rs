use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::State;

// Only account/channel identifiers and read timestamps; never message bodies.
pub struct ReadStore { path: PathBuf, lock: Mutex<()> }
type Marks = BTreeMap<String, i64>;

impl ReadStore {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Mutex::new(()) } }
    fn read(&self) -> Result<Marks, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "미확인 메시지 설정을 읽지 못했습니다. 기존 파일은 보존됩니다.".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Marks::new()),
            Err(_) => Err("미확인 메시지 설정 파일에 접근할 수 없습니다.".into()),
        }
    }
    fn load(&self) -> Result<Marks, String> {
        let _guard = self.lock.lock().map_err(|_| "미확인 메시지 설정 잠금 실패")?;
        self.read()
    }
    fn mark(&self, key: String, timestamp: i64) -> Result<i64, String> {
        if key.is_empty() || key.len() > 4096 || timestamp < 0 || timestamp > chrono::Utc::now().timestamp_millis() + 86_400_000 {
            return Err("올바르지 않은 메시지 확인 시점입니다.".into());
        }
        let _guard = self.lock.lock().map_err(|_| "미확인 메시지 설정 잠금 실패")?;
        let mut marks = self.read()?;
        let previous = marks.get(&key).copied();
        let latest = previous.unwrap_or(0).max(timestamp);
        if previous == Some(latest) { return Ok(latest); }
        marks.insert(key, latest);
        let save = || -> Result<(), Box<dyn std::error::Error>> {
            fs::create_dir_all(self.path.parent().ok_or("missing directory")?)?;
            let temporary = self.path.with_extension("tmp");
            let mut file = fs::File::create(&temporary)?;
            file.write_all(&serde_json::to_vec(&marks)?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(temporary, &self.path)?;
            Ok(())
        };
        save().map_err(|_| "메시지 확인 시점을 저장하지 못했습니다.".to_string())?;
        Ok(latest)
    }
}

#[tauri::command]
pub fn teams_load_read_marks(store: State<'_, ReadStore>) -> Result<Marks, String> { store.load() }
#[tauri::command]
pub fn teams_mark_read(store: State<'_, ReadStore>, key: String, timestamp: i64) -> Result<i64, String> { store.mark(key, timestamp) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_monotonic_marks_separately_for_accounts_and_channels() {
        let path = std::env::temp_dir().join(format!("widget-read-test-{}", rand::random::<u64>())).join("marks.json");
        let store = ReadStore::new(path.clone());
        assert!(store.load().unwrap().is_empty());
        assert_eq!(store.mark("account-a:channel".into(), 2000).unwrap(), 2000);
        assert_eq!(store.mark("account-a:channel".into(), 1000).unwrap(), 2000);
        store.mark("account-b:channel".into(), 0).unwrap();
        let saved = ReadStore::new(path.clone()).load().unwrap();
        assert_eq!(saved["account-a:channel"], 2000);
        assert_eq!(saved["account-b:channel"], 0);
        fs::write(&path, b"broken").unwrap();
        assert!(store.mark("account-a:channel".into(), 3000).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
