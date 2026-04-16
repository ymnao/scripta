mod commands;
mod watcher;

#[cfg(feature = "tauri-app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let watcher_state = std::sync::Arc::new(std::sync::Mutex::new(watcher::WatcherState::new()));
    let ogp_cache = std::sync::Arc::new(std::sync::Mutex::new(commands::ogp::OgpCache::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            use tauri::Manager;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // バージョン変更時にファイルシステム上の WebView キャッシュを削除
            // WebView 生成前に実行し、古い JS/CSS のディスクキャッシュ読み込みを防止
            let done_file = app
                .path()
                .app_data_dir()
                .unwrap_or_default()
                .join(".cache-clear-done");
            let needs_browsing_clear = match check_and_clear_cache(app) {
                Ok(needed) => needed,
                Err(e) => {
                    log::warn!("キャッシュクリアチェック失敗: {e}");
                    false
                }
            };
            app.manage(BrowsingDataClearState {
                needed: std::sync::Mutex::new(needs_browsing_clear),
                done_file,
            });

            setup_menu(app)?;

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher_state)
        .manage(ogp_cache)
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::write_new_file,
            commands::file::create_file,
            commands::file::create_directory,
            commands::file::rename_entry,
            commands::file::delete_entry,
            commands::file::show_in_folder,
            commands::file::path_exists,
            commands::file::file_exists,
            commands::workspace::list_directory,
            commands::watcher::start_watcher,
            commands::watcher::stop_watcher,
            commands::search::search_files,
            commands::search::search_filenames,
            commands::search::scan_unresolved_wikilinks,
            commands::ogp::fetch_ogp,
            commands::export::export_pdf,
            commands::git_sync::git_check_available,
            commands::git_sync::git_check_repo,
            commands::git_sync::git_status,
            commands::git_sync::git_add_all,
            commands::git_sync::git_commit,
            commands::git_sync::git_pull,
            commands::git_sync::git_push,
            commands::git_sync::git_get_conflicted_files,
            commands::git_sync::git_get_conflict_content,
            commands::git_sync::git_resolve_conflict,
            commands::git_sync::git_finish_conflict_resolution,
            commands::git_sync::git_get_last_commit_time,
            commands::updater::check_for_update,
            clear_browsing_data_if_needed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(feature = "tauri-app")]
struct BrowsingDataClearState {
    needed: std::sync::Mutex<bool>,
    done_file: std::path::PathBuf,
}

/// WebView 生成後に呼ばれ、バージョン変更時のみ clear_all_browsing_data() を実行
/// 成功時に `.cache-clear-done` を書き込み、次回起動で pending + done が揃って初めて確定
/// 失敗時はフラグが残り再呼び出し可能
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn clear_browsing_data_if_needed(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowsingDataClearState>,
) -> Result<(), String> {
    let mut guard = state.needed.lock().map_err(|e| e.to_string())?;
    if !*guard {
        return Ok(());
    }

    webview
        .clear_all_browsing_data()
        .map_err(|e| e.to_string())?;

    std::fs::write(&state.done_file, "").map_err(|e| e.to_string())?;

    *guard = false;
    Ok(())
}

/// ファイルシステム上の WebView キャッシュを削除し、browsing data クリアが必要か返す
///
/// マーカーファイルの状態遷移:
///   バージョン変更時: `.cache-version-pending` を書き込み
///   コマンド成功時:   `.cache-clear-done` を書き込み
///   次回起動時:       pending + done が揃えば `.cache-version` に確定
///                     pending のみなら browsing data クリアをリトライ
#[cfg(feature = "tauri-app")]
fn check_and_clear_cache(app: &mut tauri::App) -> Result<bool, Box<dyn std::error::Error>> {
    use tauri::Manager;

    let current_version = app.package_info().version.to_string();
    let data_dir = app.path().app_data_dir()?;
    let version_file = data_dir.join(".cache-version");
    let pending_file = data_dir.join(".cache-version-pending");
    let done_file = data_dir.join(".cache-clear-done");

    // Phase 1: 前回セッションのクリア状態を解決
    if pending_file.exists() {
        if done_file.exists() {
            // pending + done: 前回のクリアが完了 → version marker を確定
            if let Ok(v) = std::fs::read_to_string(&pending_file) {
                let _ = std::fs::write(&version_file, v.trim());
            }
            let _ = std::fs::remove_file(&pending_file);
            let _ = std::fs::remove_file(&done_file);
        } else {
            // pending のみ: 前回のクリアが未完了
            if std::fs::read_to_string(&pending_file)
                .ok()
                .map_or(false, |v| v.trim() == current_version)
            {
                // 同一バージョン — FS は済み、browsing data クリアだけリトライ
                return Ok(true);
            }
            // 異なるバージョン — 古い pending を破棄して全体やり直し
            let _ = std::fs::remove_file(&pending_file);
        }
    } else {
        // pending なし — 孤立 done があれば掃除
        let _ = std::fs::remove_file(&done_file);
    }

    // Phase 2: バージョン比較とクリア
    match std::fs::read_to_string(&version_file) {
        Ok(stored) if stored.trim() == current_version => Ok(false),
        Ok(stored) => {
            clear_webview_cache(app)?;
            log::info!(
                "WebView キャッシュをクリア: {} → {current_version}",
                stored.trim()
            );
            std::fs::write(&pending_file, &current_version)?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            clear_webview_cache(app)?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::write(&pending_file, &current_version)?;
            Ok(true)
        }
        Err(_) => {
            clear_webview_cache(app)?;
            std::fs::write(&pending_file, &current_version)?;
            Ok(true)
        }
    }
}

/// macOS/Windows: app_cache_dir に WebView キャッシュが保存される
/// Linux: Tauri は app_local_data_dir を WebKitGTK の data_directory に設定するが
///        app_data_dir と同じパスのため、アプリ設定を保持して WebView データのみ削除
#[cfg(feature = "tauri-app")]
fn clear_webview_cache(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;

    let cache_dir = app.path().app_cache_dir()?;
    remove_real_dir(&cache_dir)?;

    // Linux/Windows: Tauri は app_local_data_dir を WebView の data_directory に設定
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let local_data_dir = app.path().app_local_data_dir()?;
        remove_webview_entries(&local_data_dir)?;
    }

    Ok(())
}

/// シンボリックリンクでない実ディレクトリのみ削除
#[cfg(feature = "tauri-app")]
fn remove_real_dir(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_symlink() && meta.is_dir() => {
            std::fs::remove_dir_all(path)?;
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    Ok(())
}

/// WebView エンジンが data_directory 配下に作成する既知のエントリのみ削除
#[cfg(all(feature = "tauri-app", any(target_os = "linux", target_os = "windows")))]
fn remove_webview_entries(dir: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    const WEBVIEW_ENTRIES: &[&str] = &[
        "cookies",
        "databases",
        "disk-cache",
        "hsts",
        "icondatabase",
        "indexeddb",
        "local-storage",
        "serviceworkers",
        "blob-storage",
    ];

    #[cfg(target_os = "windows")]
    const WEBVIEW_ENTRIES: &[&str] = &["EBWebView"];

    for name in WEBVIEW_ENTRIES {
        let path = dir.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {}
            Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&path)?,
            Ok(_) => std::fs::remove_file(&path)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }

    Ok(())
}

#[cfg(feature = "tauri-app")]
fn setup_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::{Emitter, Manager};

    static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

    let handle = app.handle();

    let settings_item = MenuItemBuilder::new("Settings...")
        .id("open-settings")
        .accelerator("CmdOrCtrl+,")
        .build(handle)?;

    let app_menu = SubmenuBuilder::new(handle, "scripta")
        .about(None)
        .separator()
        .item(&settings_item)
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

    let export_item = MenuItemBuilder::new("エクスポート...")
        .id("export")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(handle)?;

    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&new_window)
        .separator()
        .item(&export_item)
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

    let keyboard_shortcuts = MenuItemBuilder::new("Keyboard Shortcuts")
        .id("open-help")
        .accelerator("F1")
        .build(handle)?;

    let help_menu = SubmenuBuilder::new(handle, "Help")
        .item(&keyboard_shortcuts)
        .build()?;

    let menu = MenuBuilder::new(handle)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(move |app_handle, event| {
        let emit_to_focused = |event_name: &str| {
            // Emit only to the focused window to avoid triggering in all windows
            let emitted = app_handle
                .webview_windows()
                .values()
                .any(|w| {
                    w.is_focused().unwrap_or(false) && w.emit(event_name, ()).is_ok()
                });
            // Fallback: if no focused window found, broadcast to all
            if !emitted {
                let _ = app_handle.emit(event_name, ());
            }
        };

        match event.id().as_ref() {
            "open-settings" => emit_to_focused("menu-open-settings"),
            "open-help" => emit_to_focused("menu-open-help"),
            "export" => emit_to_focused("menu-export"),
            "new-window" => {
                let label = format!("window-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));

                let mut builder = tauri::WebviewWindowBuilder::new(
                    app_handle,
                    &label,
                    tauri::WebviewUrl::App("/?newWindow=true".into()),
                )
                .title("scripta")
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
            _ => {}
        }
    });

    Ok(())
}
