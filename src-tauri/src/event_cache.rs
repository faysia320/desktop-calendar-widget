use std::collections::BTreeMap;
use std::path::PathBuf;
use std::ptr;
use std::sync::Mutex;

use chrono::Local;
use serde::{Deserialize, Serialize};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

use crate::oauth::{CalendarEvent, Provider};

// 달력 범위 하나가 항목 하나이므로 두 캘린더를 2년 정도 넘겨 본 분량입니다.
const MAX_ENTRIES: usize = 48;

#[derive(Serialize, Deserialize)]
pub struct CachedEvents {
    events: Vec<CalendarEvent>,
    fetched_at: String,
}

impl CachedEvents {
    pub fn into_events(self) -> Vec<CalendarEvent> {
        self.events
    }
}

/// 마지막으로 가져온 일정을 달력 범위별로 저장합니다.
pub struct EventCache {
    path: PathBuf,
    // 여러 캘린더 조회가 동시에 끝나도 서로의 저장을 덮어쓰지 않게 합니다.
    lock: Mutex<()>,
}

fn entry_key(provider: Provider, from: &str, to: &str) -> String {
    let provider = match provider {
        Provider::Google => "google",
        Provider::Microsoft => "microsoft",
    };
    format!("{provider}|{from}|{to}")
}

fn input_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr().cast_mut(),
    }
}

unsafe fn take_output(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    unsafe {
        let data = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
        LocalFree(blob.pbData.cast());
        data
    }
}

// 일정에 회사 정보가 들어가므로 현재 Windows 계정만 풀 수 있게 DPAPI로 암호화합니다.
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = input_blob(data);
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    unsafe {
        if CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(take_output(output))
    }
}

fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    let input = input_blob(data);
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    unsafe {
        if CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        ) == 0
        {
            return None;
        }
        Some(take_output(output))
    }
}

impl EventCache {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    // 파일이 없거나 손상되어도 캐시일 뿐이므로 빈 상태로 시작합니다.
    // 암호화 전에 저장된 평문 파일은 그대로 읽고 다음 저장 때 암호화합니다.
    fn read_entries(&self) -> BTreeMap<String, CachedEvents> {
        std::fs::read(&self.path)
            .ok()
            .map(|content| unprotect(&content).unwrap_or(content))
            .and_then(|content| serde_json::from_slice(&content).ok())
            .unwrap_or_default()
    }

    pub fn load(&self, provider: Provider, from: &str, to: &str) -> Option<CachedEvents> {
        let _guard = self.lock.lock().unwrap();
        self.read_entries().remove(&entry_key(provider, from, to))
    }

    pub fn store(
        &self,
        provider: Provider,
        from: &str,
        to: &str,
        events: Vec<CalendarEvent>,
    ) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        let mut entries = self.read_entries();
        entries.insert(
            entry_key(provider, from, to),
            CachedEvents {
                events,
                fetched_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            },
        );
        while entries.len() > MAX_ENTRIES {
            let Some(oldest) = entries
                .iter()
                .min_by(|a, b| a.1.fetched_at.cmp(&b.1.fetched_at))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            entries.remove(&oldest);
        }

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let content = serde_json::to_vec(&entries).map_err(|error| error.to_string())?;
        let content = protect(&content)?;
        // 저장 중 꺼져도 기존 파일이 깨지지 않도록 임시 파일을 거쳐 교체합니다.
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, content).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &self.path).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cache(name: &str) -> EventCache {
        let dir = std::env::temp_dir().join(format!(
            "calendar-widget-cache-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        EventCache::new(dir.join("events.json"))
    }

    fn event(title: &str) -> CalendarEvent {
        CalendarEvent {
            meeting: None,
            id: "1".to_string(),
            title: title.to_string(),
            start: "2026-11-05 09:00".to_string(),
            end: "2026-11-05 10:00".to_string(),
            all_day: false,
            location: None,
            calendar_id: None,
            color: None,
            text_color: None,
            editable: false,
        }
    }

    #[test]
    fn stored_events_are_loaded_per_provider_and_range() {
        let cache = temp_cache("round-trip");
        cache
            .store(Provider::Google, "2026-11-01", "2026-12-06", vec![event("회의")])
            .unwrap();

        let loaded = cache.load(Provider::Google, "2026-11-01", "2026-12-06").unwrap();
        assert_eq!(loaded.events[0].title, "회의");
        assert!(cache.load(Provider::Microsoft, "2026-11-01", "2026-12-06").is_none());
        assert!(cache.load(Provider::Google, "2026-12-01", "2027-01-03").is_none());
    }

    #[test]
    fn stored_file_does_not_contain_plain_text() {
        let cache = temp_cache("encrypted");
        cache.store(Provider::Google, "a", "b", vec![event("secret-title")]).unwrap();

        let content = std::fs::read(&cache.path).unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&content).is_err());
        assert!(!content.windows(12).any(|part| part == b"secret-title"));
    }

    #[test]
    fn plain_text_file_is_encrypted_on_next_store() {
        let cache = temp_cache("upgrade");
        std::fs::create_dir_all(cache.path.parent().unwrap()).unwrap();
        std::fs::write(
            &cache.path,
            r#"{"google|a|b":{"events":[],"fetched_at":"2026-11-05 09:00:00"}}"#,
        )
        .unwrap();

        cache.store(Provider::Google, "c", "d", Vec::new()).unwrap();

        let content = std::fs::read(&cache.path).unwrap();
        assert!(serde_json::from_slice::<serde_json::Value>(&content).is_err());
        assert!(cache.load(Provider::Google, "a", "b").is_some());
        assert!(cache.load(Provider::Google, "c", "d").is_some());
    }

    #[test]
    fn entries_saved_before_calendar_fields_still_load() {
        let cache = temp_cache("old-format");
        std::fs::create_dir_all(cache.path.parent().unwrap()).unwrap();
        std::fs::write(
            &cache.path,
            r#"{"google|a|b":{"events":[{"id":"1","title":"회의","start":"2026-11-05","end":"2026-11-06","all_day":true,"location":null}],"fetched_at":"2026-11-05 09:00:00"}}"#,
        )
        .unwrap();

        let events = cache.load(Provider::Google, "a", "b").unwrap().into_events();
        assert_eq!(events[0].title, "회의");
        assert!(!events[0].editable);
    }

    #[test]
    fn corrupted_file_is_treated_as_empty_and_replaced() {
        let cache = temp_cache("corrupted");
        std::fs::create_dir_all(cache.path.parent().unwrap()).unwrap();
        std::fs::write(&cache.path, b"not json").unwrap();

        assert!(cache.load(Provider::Google, "a", "b").is_none());
        cache.store(Provider::Google, "a", "b", vec![event("복구")]).unwrap();
        assert!(cache.load(Provider::Google, "a", "b").is_some());
    }

    #[test]
    fn oldest_entries_are_removed_over_the_limit() {
        let cache = temp_cache("prune");
        let mut entries = BTreeMap::new();
        for index in 0..MAX_ENTRIES {
            entries.insert(
                entry_key(Provider::Google, &format!("{index:03}"), "to"),
                CachedEvents {
                    events: Vec::new(),
                    fetched_at: format!("2026-01-01 00:00:{index:02}"),
                },
            );
        }
        std::fs::create_dir_all(cache.path.parent().unwrap()).unwrap();
        std::fs::write(&cache.path, serde_json::to_vec(&entries).unwrap()).unwrap();

        cache.store(Provider::Google, "new", "to", Vec::new()).unwrap();

        assert!(cache.load(Provider::Google, "000", "to").is_none());
        assert!(cache.load(Provider::Google, "001", "to").is_some());
        assert!(cache.load(Provider::Google, "new", "to").is_some());
    }
}
