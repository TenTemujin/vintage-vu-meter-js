#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;

use audio::AudioState;

#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, flag: bool) -> Result<(), String> {
    window.set_always_on_top(flag).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(AudioState::default())
        .invoke_handler(tauri::generate_handler![
            audio::list_output_devices,
            audio::start_capture,
            audio::stop_capture,
            set_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the vintage VU meter application");
}
