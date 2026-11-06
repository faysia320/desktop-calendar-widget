use std::ptr;

use tauri::WebviewWindow;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect,
};
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GWL_EXSTYLE, GWL_STYLE, GetParent, GetWindowLongPtrW, GetWindowRect, HWND_TOP,
    HWND_TOPMOST, LWA_ALPHA, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
    SetLayeredWindowAttributes, SetParent, SetWindowLongPtrW, SetWindowPos, WS_CAPTION, WS_CHILD,
    WS_EX_LAYERED, WS_POPUP,
};

fn window_handle(window: &WebviewWindow) -> Result<HWND, String> {
    Ok(window.hwnd().map_err(|error| error.to_string())?.0 as HWND)
}

fn find_desktop() -> HWND {
    let class: Vec<u16> = "Progman".encode_utf16().chain([0]).collect();
    unsafe { FindWindowW(class.as_ptr(), ptr::null()) }
}

/// Explorer가 다시 떠서 위젯을 넣을 바탕화면 창이 있는지 확인합니다.
pub fn desktop_ready() -> bool {
    !find_desktop().is_null()
}

/// 바탕화면 자식 창은 바탕화면 창의 배율로, 최상위 창은 자기 모니터의 배율로 그려집니다.
/// 맨 앞 상태에서도 고정 상태와 같은 크기로 보이도록 곱해야 할 확대 비율을 돌려줍니다.
pub fn floating_zoom(window: &WebviewWindow) -> f64 {
    let Ok(hwnd) = window_handle(window) else {
        return 1.0;
    };
    let desktop = find_desktop();
    let (desktop_dpi, window_dpi) = unsafe { (GetDpiForWindow(desktop), GetDpiForWindow(hwnd)) };
    if desktop.is_null() || desktop_dpi == 0 || window_dpi == 0 {
        return 1.0;
    }
    f64::from(desktop_dpi) / f64::from(window_dpi)
}

/// 부모 창과 상관없이 화면 기준 위치와 크기를 돌려줍니다.
pub fn screen_rect(window: &WebviewWindow) -> Option<RECT> {
    let hwnd = window_handle(window).ok()?;
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        (GetWindowRect(hwnd, &mut rect) != 0).then_some(rect)
    }
}

/// 바탕화면 창의 화면 기준 위치입니다. 모니터 배치가 바뀌면 함께 달라집니다.
pub fn desktop_rect() -> Option<(i32, i32, i32, i32)> {
    let desktop = find_desktop();
    if desktop.is_null() {
        return None;
    }
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        (GetWindowRect(desktop, &mut rect) != 0)
            .then_some((rect.left, rect.top, rect.right, rect.bottom))
    }
}

/// 위젯이 가장 많이 걸친 모니터에서 작업 표시줄을 뺀 영역을 돌려줍니다.
pub fn work_area(window: &WebviewWindow) -> Option<RECT> {
    work_area_of(screen_rect(window)?)
}

/// 주어진 영역이 가장 많이 걸친 모니터에서 작업 표시줄을 뺀 영역을 돌려줍니다.
pub fn work_area_of(rect: RECT) -> Option<RECT> {
    unsafe {
        let monitor = MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        (GetMonitorInfoW(monitor, &mut info) != 0).then_some(info.rcWork)
    }
}

/// 화면 좌표 기준으로 창을 옮깁니다. 자식 창은 부모 기준 좌표로 바꿔 적용합니다.
pub fn move_to(window: &WebviewWindow, rect: RECT) -> Result<(), String> {
    let hwnd = window_handle(window)?;
    unsafe {
        let mut origin: RECT = std::mem::zeroed();
        let parent = GetParent(hwnd);
        if !parent.is_null() {
            GetWindowRect(parent, &mut origin);
        }
        SetWindowPos(
            hwnd,
            ptr::null_mut(),
            rect.left - origin.left,
            rect.top - origin.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
    Ok(())
}

/// 위젯을 바탕화면(Progman)의 자식 창으로 넣습니다. 앱 창에는 가려지고 Win+D에서는 함께 남습니다.
/// 맨 뒤로 보낸 최상위 창은 Win+D에서 숨겨지고 뒤늦게 올려도 나타나지 않아 이 방식을 씁니다.
pub fn pin_to_desktop(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window_handle(window)?;
    let progman = find_desktop();
    if progman.is_null() {
        return Err("바탕화면 창을 찾을 수 없습니다.".to_string());
    }
    unsafe {
        let mut widget: RECT = std::mem::zeroed();
        let mut desktop: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut widget);
        GetWindowRect(progman, &mut desktop);

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        // 캡션 스타일이 남은 자식 창은 Windows가 위쪽 모서리를 둥글게 잘라 냅니다.
        SetWindowLongPtrW(
            hwnd,
            GWL_STYLE,
            ((style & !(WS_POPUP | WS_CAPTION)) | WS_CHILD) as isize,
        );
        if SetParent(hwnd, progman).is_null() {
            SetWindowLongPtrW(hwnd, GWL_STYLE, style as isize);
            return Err("바탕화면에 위젯을 넣을 수 없습니다.".to_string());
        }
        // 일반 자식 창은 투명한 부분이 배경화면과 합성되지 않아 어둡게 칠해지므로 계층 창으로 만듭니다.
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex_style | WS_EX_LAYERED) as isize);
        SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
        SetWindowPos(
            hwnd,
            HWND_TOP,
            widget.left - desktop.left,
            widget.top - desktop.top,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    Ok(())
}

/// 위젯을 바탕화면에서 꺼내 같은 화면 위치의 맨 위 창으로 만듭니다.
pub fn float_on_top(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window_handle(window)?;
    unsafe {
        let mut widget: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut widget);
        if SetParent(hwnd, ptr::null_mut()).is_null() {
            return Err("바탕화면에서 위젯을 꺼낼 수 없습니다.".to_string());
        }
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        SetWindowLongPtrW(
            hwnd,
            GWL_STYLE,
            ((style & !WS_CHILD) | WS_POPUP | WS_CAPTION) as isize,
        );
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex_style & !WS_EX_LAYERED) as isize);
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            widget.left,
            widget.top,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
    Ok(())
}
