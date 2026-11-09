// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Keep embedded UI assets in this small binary crate. Editing HTML/CSS/JS
    // then recompiles this entry point, rather than the entire native backend.
    desktop_calendar_widget_lib::run(tauri::generate_context!())
}
