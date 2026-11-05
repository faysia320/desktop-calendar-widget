use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError};
use windows_sys::Win32::System::Threading::CreateMutexW;

const MUTEX_NAME: &str = "Local\\com.rocket.desktopcalendarwidget";

static MUTEX: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(ptr::null_mut());

/// 이미 실행 중인 위젯이 있으면 false를 돌려줍니다.
pub fn acquire() -> bool {
    let name: Vec<u16> = MUTEX_NAME.encode_utf16().chain([0]).collect();
    unsafe {
        let handle = CreateMutexW(ptr::null(), 0, name.as_ptr());
        if handle.is_null() {
            // 확인할 수 없을 때 위젯이 아예 뜨지 않는 것보다 중복 실행이 낫습니다.
            return true;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return false;
        }
        MUTEX.store(handle, Ordering::SeqCst);
    }
    true
}

/// 재시작으로 뜨는 새 프로세스가 막히지 않도록 먼저 풀어 줍니다.
pub fn release() {
    let handle = MUTEX.swap(ptr::null_mut(), Ordering::SeqCst);
    if !handle.is_null() {
        unsafe {
            CloseHandle(handle);
        }
    }
}
