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

                // Create print operation from WKWebView and run modally
                let print_op = wk_webview.printOperationWithPrintInfo(&print_info);
                print_op.setShowsPrintPanel(false);
                print_op.setShowsProgressPanel(false);

                let ns_window: &objc2_app_kit::NSWindow =
                    &*platform_wv.ns_window().cast();
                print_op
                    .runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                        ns_window,
                        None,
                        None,
                        std::ptr::null_mut(),
                    );

                // Signal that the print operation has been dispatched.
                // Do NOT block the main thread — the print operation needs
                // the run loop to complete writing the PDF file.
                let _ = tx.send(Ok(()));
            }
        });

        if let Err(e) = res {
            let _ = tx_err.send(Err(format!("WebView操作に失敗しました: {e}")));
        }
    })
    .build()
    .map_err(|e| format!("PDFエクスポート用ウィンドウの作成に失敗しました: {e}"))?;

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

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn export_pdf(
    _app_handle: tauri::AppHandle,
    _html: String,
    _output_path: String,
) -> Result<(), String> {
    Err("PDFエクスポートは現在macOSのみ対応しています".to_string())
}
