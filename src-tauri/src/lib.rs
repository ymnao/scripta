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
            let cache_cleared = match check_and_clear_cache(app) {
                Ok(cleared) => cleared,
                Err(e) => {
                    log::warn!("キャッシュクリアチェック失敗: {e}");
                    false
                }
            };
            // macOS: WKWebsiteDataStore のキャッシュは FS 削除では除去できないため
            // WebView 生成後に clear_all_browsing_data() で best-effort 削除する
            let done_file = app
                .path()
                .app_data_dir()
                .unwrap_or_default()
                .join(".cache-clear-done");
            app.manage(WebViewCacheClearState {
                needed: std::sync::atomic::AtomicBool::new(cache_cleared),
                clear_requested: std::sync::atomic::AtomicBool::new(false),
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
            clear_webview_browsing_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// macOS の clear_all_browsing_data() 呼び出し状態を管理する
///
/// macOS では clear_all_browsing_data() が非同期で完了前に返るため:
/// - コマンド成功時: clear_requested フラグを立てる
/// - アプリ正常終了時（Drop）: `.cache-clear-done` マーカーを書き込む
/// - 次回起動時: pending + done が揃えば `.cache-version` に確定
///
/// これにより非同期削除の完了猶予としてアプリの全稼働時間を確保する
/// 異常終了時は Drop が走らず done が書かれないため、次回起動でリトライされる
#[cfg(feature = "tauri-app")]
struct WebViewCacheClearState {
    needed: std::sync::atomic::AtomicBool,
    clear_requested: std::sync::atomic::AtomicBool,
    done_file: std::path::PathBuf,
}

#[cfg(feature = "tauri-app")]
impl Drop for WebViewCacheClearState {
    fn drop(&mut self) {
        if self
            .clear_requested
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let _ = std::fs::write(&self.done_file, "");
        }
    }
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
#[allow(unused_variables)]
fn clear_webview_browsing_data(
    webview: tauri::Webview,
    state: tauri::State<'_, WebViewCacheClearState>,
) -> Result<(), String> {
    if !state
        .needed
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        webview
            .clear_all_browsing_data()
            .map_err(|e| e.to_string())?;
        // done marker はアプリ正常終了時（Drop）に書き込む
        state
            .clear_requested
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    state
        .needed
        .store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// マーカーファイルの読み取り状態
#[derive(Debug, PartialEq)]
struct MarkerState {
    /// `.cache-version` の内容
    version: Option<String>,
    /// `.cache-version-pending` の内容
    pending: Option<String>,
}

/// `plan_cache_actions` が返すアクション
#[derive(Debug, PartialEq)]
struct CacheActions {
    /// pending を version に昇格する
    confirm_pending: bool,
    /// ファイルシステムのキャッシュを削除する
    clear_cache: bool,
    /// 新しい pending を書き込む（値はバージョン文字列）
    write_pending: Option<String>,
}

/// マーカーの状態から必要なアクションを決定する純粋関数
///
/// 状態遷移:
///   バージョン変更時: FS キャッシュ削除 + `.cache-version-pending` 書き込み
///   次回起動時:       pending を `.cache-version` に昇格（確定）
fn plan_cache_actions(current_version: &str, state: &MarkerState) -> CacheActions {
    // pending があれば、前回のクリア済みバージョンとして優先
    let effective_version = state.pending.as_deref().or(state.version.as_deref());
    let version_matches = effective_version.map_or(false, |v| v == current_version);

    CacheActions {
        confirm_pending: state.pending.is_some(),
        clear_cache: !version_matches,
        write_pending: if version_matches {
            None
        } else {
            Some(current_version.to_string())
        },
    }
}

/// 前回セッションの pending マーカーを解決する
///
/// `require_done_for_confirm`: true の場合、pending + done が揃ったときのみ確定
/// （macOS で clear_all_browsing_data() の非同期完了猶予として使用）
///
/// 戻り値: pending が確定されたか
fn resolve_pending(
    actions: &CacheActions,
    state: &MarkerState,
    version_file: &std::path::Path,
    pending_file: &std::path::Path,
    done_file: &std::path::Path,
    require_done_for_confirm: bool,
) -> Result<bool, Box<dyn std::error::Error>> {
    let done_exists = done_file.exists();

    if actions.confirm_pending {
        let should_confirm = !require_done_for_confirm || done_exists;
        if should_confirm {
            if let Some(ref v) = state.pending {
                std::fs::write(version_file, v.as_str())?;
            }
            let _ = std::fs::remove_file(pending_file);
            let _ = std::fs::remove_file(done_file);
            return Ok(true);
        }
    } else if done_exists {
        let _ = std::fs::remove_file(done_file);
    }

    Ok(false)
}

/// マーカーファイルを読み取り、必要に応じてキャッシュを削除する
#[cfg(feature = "tauri-app")]
fn check_and_clear_cache(app: &mut tauri::App) -> Result<bool, Box<dyn std::error::Error>> {
    use tauri::Manager;

    let current_version = app.package_info().version.to_string();
    let data_dir = app.path().app_data_dir()?;
    let version_file = data_dir.join(".cache-version");
    let pending_file = data_dir.join(".cache-version-pending");
    let done_file = data_dir.join(".cache-clear-done");

    let state = MarkerState {
        version: std::fs::read_to_string(&version_file)
            .ok()
            .map(|s| s.trim().to_string()),
        pending: std::fs::read_to_string(&pending_file)
            .ok()
            .map(|s| s.trim().to_string()),
    };

    let actions = plan_cache_actions(&current_version, &state);

    let pending_confirmed = resolve_pending(
        &actions,
        &state,
        &version_file,
        &pending_file,
        &done_file,
        cfg!(target_os = "macos"),
    )?;

    if actions.clear_cache {
        clear_webview_cache(app)?;
        let from = state
            .pending
            .as_deref()
            .or(state.version.as_deref())
            .unwrap_or("(なし)");
        log::info!("WebView キャッシュをクリア: {from} → {current_version}");
    }

    if let Some(ref version) = actions.write_pending {
        std::fs::create_dir_all(&data_dir)?;
        std::fs::write(&pending_file, version.as_str())?;
    }

    let needs_webview_clear = if cfg!(target_os = "macos") {
        actions.clear_cache || (actions.confirm_pending && !pending_confirmed)
    } else {
        actions.clear_cache
    };

    Ok(needs_webview_clear)
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

#[cfg(test)]
mod cache_tests {
    use super::*;

    fn state(version: Option<&str>, pending: Option<&str>) -> MarkerState {
        MarkerState {
            version: version.map(String::from),
            pending: pending.map(String::from),
        }
    }

    #[test]
    fn fresh_install_clears_and_writes_pending() {
        let actions = plan_cache_actions("0.1.2", &state(None, None));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: false,
                clear_cache: true,
                write_pending: Some("0.1.2".into()),
            }
        );
    }

    #[test]
    fn same_version_does_nothing() {
        let actions = plan_cache_actions("0.1.2", &state(Some("0.1.2"), None));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: false,
                clear_cache: false,
                write_pending: None,
            }
        );
    }

    #[test]
    fn version_upgrade_clears_and_writes_pending() {
        let actions = plan_cache_actions("0.1.2", &state(Some("0.1.1"), None));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: false,
                clear_cache: true,
                write_pending: Some("0.1.2".into()),
            }
        );
    }

    #[test]
    fn pending_from_previous_session_confirmed() {
        let actions = plan_cache_actions("0.1.2", &state(Some("0.1.1"), Some("0.1.2")));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: true,
                clear_cache: false,
                write_pending: None,
            }
        );
    }

    #[test]
    fn pending_confirmed_then_another_update() {
        let actions = plan_cache_actions("0.1.3", &state(Some("0.1.1"), Some("0.1.2")));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: true,
                clear_cache: true,
                write_pending: Some("0.1.3".into()),
            }
        );
    }

    #[test]
    fn pending_without_version_file_confirmed() {
        let actions = plan_cache_actions("0.1.2", &state(None, Some("0.1.2")));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: true,
                clear_cache: false,
                write_pending: None,
            }
        );
    }

    #[test]
    fn stale_pending_triggers_full_clear() {
        let actions = plan_cache_actions("0.1.2", &state(None, Some("0.1.1")));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: true,
                clear_cache: true,
                write_pending: Some("0.1.2".into()),
            }
        );
    }

    #[test]
    fn downgrade_clears_cache() {
        let actions = plan_cache_actions("0.1.1", &state(Some("0.1.2"), None));
        assert_eq!(
            actions,
            CacheActions {
                confirm_pending: false,
                clear_cache: true,
                write_pending: Some("0.1.1".into()),
            }
        );
    }

    // --- resolve_pending tests ---

    fn setup_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn resolve_pending_with_done_confirms() {
        let dir = setup_dir();
        let version = dir.path().join("version");
        let pending = dir.path().join("pending");
        let done = dir.path().join("done");

        std::fs::write(&pending, "0.1.2").unwrap();
        std::fs::write(&done, "").unwrap();

        let s = state(Some("0.1.1"), Some("0.1.2"));
        let actions = CacheActions {
            confirm_pending: true,
            clear_cache: false,
            write_pending: None,
        };

        let confirmed = resolve_pending(&actions, &s, &version, &pending, &done, true).unwrap();

        assert!(confirmed);
        assert_eq!(std::fs::read_to_string(&version).unwrap(), "0.1.2");
        assert!(!pending.exists());
        assert!(!done.exists());
    }

    #[test]
    fn resolve_pending_without_done_does_not_confirm_when_required() {
        let dir = setup_dir();
        let version = dir.path().join("version");
        let pending = dir.path().join("pending");
        let done = dir.path().join("done");

        std::fs::write(&pending, "0.1.2").unwrap();

        let s = state(Some("0.1.1"), Some("0.1.2"));
        let actions = CacheActions {
            confirm_pending: true,
            clear_cache: false,
            write_pending: None,
        };

        let confirmed = resolve_pending(&actions, &s, &version, &pending, &done, true).unwrap();

        assert!(!confirmed);
        assert!(!version.exists());
        assert!(pending.exists());
    }

    #[test]
    fn resolve_pending_without_done_confirms_when_not_required() {
        let dir = setup_dir();
        let version = dir.path().join("version");
        let pending = dir.path().join("pending");
        let done = dir.path().join("done");

        std::fs::write(&pending, "0.1.2").unwrap();

        let s = state(Some("0.1.1"), Some("0.1.2"));
        let actions = CacheActions {
            confirm_pending: true,
            clear_cache: false,
            write_pending: None,
        };

        let confirmed = resolve_pending(&actions, &s, &version, &pending, &done, false).unwrap();

        assert!(confirmed);
        assert_eq!(std::fs::read_to_string(&version).unwrap(), "0.1.2");
        assert!(!pending.exists());
    }

    #[test]
    fn resolve_cleans_orphaned_done() {
        let dir = setup_dir();
        let version = dir.path().join("version");
        let pending = dir.path().join("pending");
        let done = dir.path().join("done");

        std::fs::write(&done, "").unwrap();

        let s = state(Some("0.1.2"), None);
        let actions = CacheActions {
            confirm_pending: false,
            clear_cache: false,
            write_pending: None,
        };

        let confirmed = resolve_pending(&actions, &s, &version, &pending, &done, true).unwrap();

        assert!(!confirmed);
        assert!(!done.exists());
    }

    // --- integration: full marker round-trip ---

    #[test]
    fn full_round_trip_without_done_requirement() {
        let dir = setup_dir();
        let data_dir = dir.path();
        let version_file = data_dir.join("version");
        let pending_file = data_dir.join("pending");
        let done_file = data_dir.join("done");

        // Startup 1: fresh install → clear + pending
        let s1 = MarkerState {
            version: None,
            pending: None,
        };
        let a1 = plan_cache_actions("0.1.2", &s1);
        assert!(a1.clear_cache);
        resolve_pending(&a1, &s1, &version_file, &pending_file, &done_file, false).unwrap();
        if let Some(ref v) = a1.write_pending {
            std::fs::write(&pending_file, v.as_str()).unwrap();
        }

        // Startup 2: pending confirmed
        let s2 = MarkerState {
            version: std::fs::read_to_string(&version_file)
                .ok()
                .map(|s| s.trim().to_string()),
            pending: std::fs::read_to_string(&pending_file)
                .ok()
                .map(|s| s.trim().to_string()),
        };
        let a2 = plan_cache_actions("0.1.2", &s2);
        assert!(!a2.clear_cache);
        assert!(a2.confirm_pending);
        let confirmed =
            resolve_pending(&a2, &s2, &version_file, &pending_file, &done_file, false).unwrap();
        assert!(confirmed);
        assert_eq!(std::fs::read_to_string(&version_file).unwrap(), "0.1.2");
        assert!(!pending_file.exists());

        // Startup 3: stable
        let s3 = MarkerState {
            version: std::fs::read_to_string(&version_file)
                .ok()
                .map(|s| s.trim().to_string()),
            pending: None,
        };
        let a3 = plan_cache_actions("0.1.2", &s3);
        assert!(!a3.clear_cache);
        assert!(!a3.confirm_pending);
    }

    #[test]
    fn full_round_trip_with_done_requirement() {
        let dir = setup_dir();
        let data_dir = dir.path();
        let version_file = data_dir.join("version");
        let pending_file = data_dir.join("pending");
        let done_file = data_dir.join("done");

        // Startup 1: version change → clear + pending
        std::fs::write(&version_file, "0.1.1").unwrap();
        let s1 = MarkerState {
            version: Some("0.1.1".into()),
            pending: None,
        };
        let a1 = plan_cache_actions("0.1.2", &s1);
        resolve_pending(&a1, &s1, &version_file, &pending_file, &done_file, true).unwrap();
        std::fs::write(&pending_file, "0.1.2").unwrap();

        // Startup 2: pending without done → not confirmed, needs retry
        let s2 = MarkerState {
            version: Some("0.1.1".into()),
            pending: Some("0.1.2".into()),
        };
        let a2 = plan_cache_actions("0.1.2", &s2);
        let confirmed =
            resolve_pending(&a2, &s2, &version_file, &pending_file, &done_file, true).unwrap();
        assert!(!confirmed);
        assert!(pending_file.exists());

        // Simulate: command runs, Drop writes done
        std::fs::write(&done_file, "").unwrap();

        // Startup 3: pending + done → confirmed
        let s3 = MarkerState {
            version: Some("0.1.1".into()),
            pending: Some("0.1.2".into()),
        };
        let a3 = plan_cache_actions("0.1.2", &s3);
        let confirmed =
            resolve_pending(&a3, &s3, &version_file, &pending_file, &done_file, true).unwrap();
        assert!(confirmed);
        assert_eq!(std::fs::read_to_string(&version_file).unwrap(), "0.1.2");
        assert!(!pending_file.exists());
        assert!(!done_file.exists());
    }
}
