#[cfg(feature = "tauri-app")]
use crate::watcher::WatcherState;
#[cfg(feature = "tauri-app")]
use std::sync::{Arc, Mutex};

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn start_watcher(
    path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<WatcherState>>>,
) -> Result<(), String> {
    let mut watcher_state = state.lock().map_err(|e| e.to_string())?;
    watcher_state.start(&path, app_handle)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn stop_watcher(
    state: tauri::State<'_, Arc<Mutex<WatcherState>>>,
) -> Result<(), String> {
    let mut watcher_state = state.lock().map_err(|e| e.to_string())?;
    watcher_state.stop();
    Ok(())
}
