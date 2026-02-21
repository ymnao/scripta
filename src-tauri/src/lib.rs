mod commands;
mod watcher;

#[cfg(feature = "tauri-app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let watcher_state =
        std::sync::Arc::new(std::sync::Mutex::new(watcher::WatcherState::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher_state)
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::create_file,
            commands::file::create_directory,
            commands::file::rename_entry,
            commands::file::delete_entry,
            commands::workspace::list_directory,
            commands::watcher::start_watcher,
            commands::watcher::stop_watcher,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
