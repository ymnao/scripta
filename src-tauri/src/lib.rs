mod commands;
mod watcher;

#[cfg(feature = "tauri-app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let watcher_state = std::sync::Arc::new(std::sync::Mutex::new(watcher::WatcherState::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            setup_menu(app)?;

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
            commands::search::search_files,
            commands::search::search_filenames,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(feature = "tauri-app")]
fn setup_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

    let handle = app.handle();

    let app_menu = SubmenuBuilder::new(handle, "mark-draft")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_window = MenuItemBuilder::new("New Window")
        .id("new-window")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(handle)?;

    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&new_window)
        .build()?;

    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let menu = MenuBuilder::new(handle)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(move |app_handle, event| {
        if event.id().as_ref() == "new-window" {
            let label = format!("window-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));

            let mut builder = tauri::WebviewWindowBuilder::new(
                app_handle,
                &label,
                tauri::WebviewUrl::App("/?newWindow=true".into()),
            )
            .title("mark-draft")
            .inner_size(800.0, 600.0);

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            if let Err(e) = builder.build() {
                log::error!("Failed to create new window: {e}");
            }
        }
    });

    Ok(())
}
