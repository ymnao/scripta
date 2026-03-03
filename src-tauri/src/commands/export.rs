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

    let file_url = format!("file://{}", tmp_html.display());
    let label = format!("pdf-export-{}", COUNTER.fetch_add(1, Ordering::Relaxed));

    // Channel to signal that the print operation has been started
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);

    let output = output_path.clone();

    let webview_window = tauri::webview::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        WebviewUrl::External(file_url.parse::<tauri::Url>().map_err(|e| e.to_string())?),
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

        // Poll for the PDF file to appear (print operation writes it asynchronously)
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(meta) = std::fs::metadata(&output_for_poll) {
                if meta.len() > 0 {
                    // File exists and has content — give a small grace period
                    // for the write to finish
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

    let file_url = format!("file://{}", tmp_html.display());
    let label = format!("pdf-export-{}", COUNTER.fetch_add(1, Ordering::Relaxed));

    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let output = output_path.clone();

    let webview_window = tauri::webview::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        WebviewUrl::External(file_url.parse::<tauri::Url>().map_err(|e| e.to_string())?),
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
            unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::*;
                use webview2_com::PrintToPdfCompletedHandler;
                use windows::core::Interface;

                let controller = platform_wv.controller();
                let core = controller.CoreWebView2().unwrap();

                // ICoreWebView2 -> ICoreWebView2_2 -> Environment -> ICoreWebView2Environment6
                let core2: ICoreWebView2_2 = core.cast().unwrap();
                let env = core2.Environment().unwrap();
                let env6: ICoreWebView2Environment6 = env.cast().unwrap();

                let settings = env6.CreatePrintSettings().unwrap();

                // A4 size in inches: 8.27 x 11.69
                settings.SetPageWidth(8.27).unwrap();
                settings.SetPageHeight(11.69).unwrap();

                // Margins 20mm = 0.787in
                settings.SetMarginTop(0.787).unwrap();
                settings.SetMarginBottom(0.787).unwrap();
                settings.SetMarginLeft(0.787).unwrap();
                settings.SetMarginRight(0.787).unwrap();

                settings.SetShouldPrintBackgrounds(true).unwrap();
                settings.SetShouldPrintHeaderAndFooter(false).unwrap();

                // ICoreWebView2_7::PrintToPdf
                let core7: ICoreWebView2_7 = core.cast().unwrap();

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
                    .unwrap();
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
