#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn export_pdf(
    app_handle: tauri::AppHandle,
    html: String,
    output_path: String,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::WebviewUrl;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    // Write HTML to a temp file so the WebView can load it via file://
    let tmp_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let tmp_html = tmp_dir.path().join("export.html");
    std::fs::write(&tmp_html, &html).map_err(|e| e.to_string())?;

    let file_url = tauri::Url::from_file_path(&tmp_html)
        .map_err(|()| format!("無効なファイルパスです: {}", tmp_html.display()))?;
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("pdf-export-{counter}");

    // Clean up any stale .scripta-backup-* files from previous crashes.
    // If the output file doesn't exist but a backup does, restore it first.
    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        let prefix = format!(
            "{}.scripta-backup-",
            std::path::Path::new(&output_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        );
        if let Ok(entries) = std::fs::read_dir(parent) {
            let output_exists = std::fs::metadata(&output_path).is_ok();
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with(&prefix) {
                    if !output_exists {
                        // Restore the first backup found as the original file
                        let _ = std::fs::rename(entry.path(), &output_path);
                    }
                    // Remove any remaining stale backups
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    // If a file already exists at the output path, move it to a temporary
    // backup so we can unambiguously detect the new file.  On failure the
    // backup is restored, avoiding data loss.
    // Use PID + counter for a globally unique name that survives app restarts
    // and avoids collisions with concurrent exports.
    let backup_path = format!(
        "{}.scripta-backup-{}-{counter}",
        output_path,
        std::process::id()
    );
    let has_backup = match std::fs::rename(&output_path, &backup_path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            return Err(format!("既存ファイルの退避に失敗しました: {e}"));
        }
    };

    // Channel to signal that the print operation has been started
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);

    let output = output_path.clone();

    let webview_window = tauri::webview::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        WebviewUrl::External(file_url),
    )
    .title("PDF Export")
    .inner_size(800.0, 600.0)
    .decorations(false)
    .visible(false)
    .on_page_load(move |webview, payload| {
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            return;
        }

        let output = output.clone();
        let tx = tx.clone();
        let tx_err = tx.clone();

        let res = webview.with_webview(move |platform_wv| {
            // SAFETY: with_webview runs on the main thread; we access macOS AppKit/WebKit API
            unsafe {
                use objc2_app_kit::{
                    NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob,
                    NSPrintingPaginationMode,
                };
                use objc2_foundation::{NSSize, NSURL};
                use objc2_web_kit::WKWebView;

                let wk_webview: &WKWebView = &*platform_wv.inner().cast();

                // Make window completely invisible before runOperationModalForWindow
                // forces it to the front. alphaValue=0 makes the entire window
                // (including decorations) transparent, hasShadow=false removes the
                // drop shadow that would otherwise be visible.
                let ns_window: &objc2::runtime::AnyObject =
                    &*platform_wv.ns_window().cast();
                let _: () = objc2::msg_send![ns_window, setAlphaValue: 0.0f64];
                let _: () = objc2::msg_send![ns_window, setHasShadow: false];

                // Configure print info for A4 PDF output
                let print_info = NSPrintInfo::new();

                // A4 size in points (1pt = 1/72 inch): 595.28 x 841.89
                print_info.setPaperSize(NSSize {
                    width: 595.28,
                    height: 841.89,
                });

                // Set margins (20mm ≈ 56.69pt)
                print_info.setTopMargin(56.69);
                print_info.setBottomMargin(56.69);
                print_info.setLeftMargin(56.69);
                print_info.setRightMargin(56.69);

                // Ensure content paginates across pages (not fit-to-single-page)
                print_info.setHorizontalPagination(NSPrintingPaginationMode::Clip);
                print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
                print_info.setScalingFactor(1.0);

                // Save as PDF file (no print dialog)
                print_info.setJobDisposition(NSPrintSaveJob);

                // Set output path via NSPrintJobSavingURL in the dictionary
                let output_url = NSURL::fileURLWithPath(
                    &objc2_foundation::NSString::from_str(&output),
                );
                let dict = print_info.dictionary();
                let _: () = objc2::msg_send![
                    &*dict, setObject: &*output_url, forKey: NSPrintJobSavingURL
                ];

                // Create print operation from WKWebView
                let print_op = wk_webview.printOperationWithPrintInfo(&print_info);
                print_op.setShowsPrintPanel(false);
                print_op.setShowsProgressPanel(false);

                // Must use runOperationModalForWindow (not runOperation) because
                // WKWebView needs the modal session's run loop to process IPC
                // with its WebContent process; runOperation deadlocks.
                let ns_window: &objc2_app_kit::NSWindow =
                    &*platform_wv.ns_window().cast();
                print_op
                    .runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                        ns_window,
                        None,
                        None,
                        std::ptr::null_mut(),
                    );

                let _ = tx.send(Ok(()));
            }
        });

        if let Err(e) = res {
            let _ = tx_err.send(Err(format!("WebView操作に失敗しました: {e}")));
        }
    })
    .build()
    .map_err(|e| format!("PDFエクスポート用ウィンドウの作成に失敗しました: {e}"))?;

    // Immediately make the window invisible (before page load starts).
    // with_webview dispatches to the main thread, but it will execute
    // before on_page_load(Finished) since the page hasn't loaded yet.
    let _ = webview_window.with_webview(|platform_wv| {
        unsafe {
            let ns_window: &objc2::runtime::AnyObject =
                &*platform_wv.ns_window().cast();
            let _: () = objc2::msg_send![ns_window, setAlphaValue: 0.0f64];
            let _: () = objc2::msg_send![ns_window, setHasShadow: false];
        }
    });

    // Wait for the print operation to be dispatched, then poll for the output file
    let output_for_poll = output_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // First, wait for on_page_load to fire and start the print operation
        let started = rx
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|e| Err(format!("PDFエクスポートがタイムアウトしました: {e}")));
        started?;

        // Poll for the PDF file to appear (fresh — no ambiguity with old data)
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(meta) = std::fs::metadata(&output_for_poll) {
                if meta.len() > 0 {
                    // Give a small grace period for the write to finish
                    std::thread::sleep(Duration::from_millis(200));
                    return Ok(());
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err("PDFの書き出しがタイムアウトしました".to_string());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })
    .await
    .map_err(|e| format!("PDFエクスポートタスクエラー: {e}"))?;

    // Cleanup
    let _ = webview_window.close();
    drop(tmp_dir);

    // On success, remove the backup; on failure, restore it.
    if result.is_ok() {
        if has_backup {
            if let Err(e) = std::fs::remove_file(&backup_path) {
                log::warn!("バックアップファイルの削除に失敗: {backup_path}: {e}");
            }
        }
    } else if has_backup {
        // Remove any partial/empty file left by the failed print operation
        // before restoring the backup (rename atomically replaces on Unix,
        // but removing first makes the intent explicit).
        let _ = std::fs::remove_file(&output_path);
        if let Err(e) = std::fs::rename(&backup_path, &output_path) {
            log::warn!("バックアップファイルの復元に失敗: {backup_path}: {e}");
        }
    }

    result
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn export_pdf(
    app_handle: tauri::AppHandle,
    html: String,
    output_path: String,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::WebviewUrl;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    // Write HTML to a temp file so the WebView can load it via file://
    let tmp_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let tmp_html = tmp_dir.path().join("export.html");
    std::fs::write(&tmp_html, &html).map_err(|e| e.to_string())?;

    let file_url = tauri::Url::from_file_path(&tmp_html)
        .map_err(|()| format!("無効なファイルパスです: {}", tmp_html.display()))?;
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("pdf-export-{counter}");

    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let output = output_path.clone();

    let webview_window = tauri::webview::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        WebviewUrl::External(file_url),
    )
    .title("PDF Export")
    .inner_size(800.0, 600.0)
    .visible(false)
    .on_page_load(move |webview, payload| {
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            return;
        }

        let output = output.clone();
        let tx = tx.clone();
        let tx_err = tx.clone();

        let res = webview.with_webview(move |platform_wv| {
            // SAFETY: with_webview runs on the main thread; we access WebView2 COM API
            let result: Result<(), String> = unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::*;
                use webview2_com::PrintToPdfCompletedHandler;
                use windows::core::Interface;

                let controller = platform_wv.controller();
                let core = controller
                    .CoreWebView2()
                    .map_err(|e| format!("CoreWebView2の取得に失敗: {e}"))?;

                let core2: ICoreWebView2_2 = core
                    .cast()
                    .map_err(|e| format!("ICoreWebView2_2へのキャストに失敗: {e}"))?;
                let env = core2
                    .Environment()
                    .map_err(|e| format!("Environmentの取得に失敗: {e}"))?;
                let env6: ICoreWebView2Environment6 = env
                    .cast()
                    .map_err(|e| format!("ICoreWebView2Environment6へのキャストに失敗: {e}"))?;

                let settings = env6
                    .CreatePrintSettings()
                    .map_err(|e| format!("PrintSettingsの作成に失敗: {e}"))?;

                // A4 size in inches: 8.27 x 11.69
                settings.SetPageWidth(8.27).map_err(|e| e.to_string())?;
                settings.SetPageHeight(11.69).map_err(|e| e.to_string())?;

                // Margins 20mm = 0.787in
                settings.SetMarginTop(0.787).map_err(|e| e.to_string())?;
                settings.SetMarginBottom(0.787).map_err(|e| e.to_string())?;
                settings.SetMarginLeft(0.787).map_err(|e| e.to_string())?;
                settings.SetMarginRight(0.787).map_err(|e| e.to_string())?;

                settings
                    .SetShouldPrintBackgrounds(true)
                    .map_err(|e| e.to_string())?;
                settings
                    .SetShouldPrintHeaderAndFooter(false)
                    .map_err(|e| e.to_string())?;

                // ICoreWebView2_7::PrintToPdf
                let core7: ICoreWebView2_7 = core
                    .cast()
                    .map_err(|e| format!("ICoreWebView2_7へのキャストに失敗: {e}"))?;

                let output_wide: Vec<u16> = output
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();

                let handler = PrintToPdfCompletedHandler::create(Box::new(
                    move |hresult, is_successful| {
                        if hresult.is_ok() && is_successful {
                            let _ = tx.send(Ok(()));
                        } else {
                            let _ = tx.send(Err(format!(
                                "PDF書き出しに失敗しました (HRESULT: {:?})",
                                hresult
                            )));
                        }
                        Ok(())
                    },
                ));

                core7
                    .PrintToPdf(
                        windows::core::PCWSTR(output_wide.as_ptr()),
                        &settings,
                        &handler,
                    )
                    .map_err(|e| format!("PrintToPdfの呼び出しに失敗: {e}"))?;

                Ok(())
            };

            if let Err(e) = result {
                let _ = tx_err.send(Err(e));
            }
        });

        if let Err(e) = res {
            let _ = tx_err.send(Err(format!("WebView操作に失敗しました: {e}")));
        }
    })
    .build()
    .map_err(|e| format!("PDFエクスポート用ウィンドウの作成に失敗しました: {e}"))?;

    // Wait for PrintToPdf completion callback
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|e| Err(format!("PDFエクスポートがタイムアウトしました: {e}")))
    })
    .await
    .map_err(|e| format!("PDFエクスポートタスクエラー: {e}"))?;

    // Cleanup
    let _ = webview_window.close();
    drop(tmp_dir);

    result
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
pub async fn export_pdf(
    _app_handle: tauri::AppHandle,
    _html: String,
    _output_path: String,
) -> Result<(), String> {
    Err("PDFエクスポートはmacOS・Windowsのみ対応しています".to_string())
}
