#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn export_pdf(
    app_handle: tauri::AppHandle,
    html: String,
    output_path: String,
) -> Result<(), String> {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::WebviewUrl;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    // Write HTML to a temp file so the WebView can load it via file://
    let tmp_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let tmp_html = tmp_dir.path().join("export.html");
    fs::write(&tmp_html, &html).map_err(|e| e.to_string())?;

    let file_url = format!("file://{}", tmp_html.display());
    let label = format!("pdf-export-{}", COUNTER.fetch_add(1, Ordering::Relaxed));

    // sync_channel: SyncSender is Send + Sync (required by on_page_load: Fn + Send + Sync)
    let (tx, rx) = mpsc::sync_channel::<Result<(), String>>(1);

    let output = output_path.clone();

    let webview_window = tauri::webview::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        WebviewUrl::External(file_url.parse::<tauri::Url>().map_err(|e| e.to_string())?),
    )
    .title("PDF Export")
    .inner_size(800.0, 1200.0)
    .visible(false)
    .on_page_load(move |webview, payload| {
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            return;
        }

        let output = output.clone();
        let tx = tx.clone();
        let tx_err = tx.clone();

        let res = webview.with_webview(move |platform_wv| {
            // SAFETY: with_webview runs on the main thread; we access macOS WKWebView API
            unsafe {
                use block2::RcBlock;
                use objc2::MainThreadMarker;
                use objc2_web_kit::{WKPDFConfiguration, WKWebView};

                let wk_webview: &WKWebView = &*platform_wv.inner().cast();
                let mtm =
                    MainThreadMarker::new().expect("with_webview runs on main thread");
                let config = WKPDFConfiguration::new(mtm);

                // A4 size in points (1pt = 1/72 inch): 595.28 x 841.89
                use objc2_foundation::{NSPoint, NSRect, NSSize};
                let a4_rect = NSRect {
                    origin: NSPoint { x: 0.0, y: 0.0 },
                    size: NSSize {
                        width: 595.28,
                        height: 841.89,
                    },
                };
                config.setRect(a4_rect);

                let block = RcBlock::new(
                    move |data: *mut objc2_foundation::NSData,
                          error: *mut objc2_foundation::NSError| {
                        let result = if !error.is_null() {
                            let err = &*error;
                            Err(format!(
                                "PDF生成に失敗しました: {}",
                                err.localizedDescription()
                            ))
                        } else if data.is_null() {
                            Err("PDF生成に失敗しました: データが空です".to_string())
                        } else {
                            let ns_data = &*data;
                            let bytes = ns_data.to_vec();
                            fs::write(&output, &bytes).map_err(|e| {
                                format!("PDFファイルの書き込みに失敗しました: {e}")
                            })
                        };
                        let _ = tx.send(result);
                    },
                );

                wk_webview
                    .createPDFWithConfiguration_completionHandler(Some(&config), &block);
            }
        });

        if let Err(e) = res {
            let _ = tx_err.send(Err(format!("WebView操作に失敗しました: {e}")));
        }
    })
    .build()
    .map_err(|e| format!("PDFエクスポート用ウィンドウの作成に失敗しました: {e}"))?;

    // Wait for PDF generation with 30s timeout (blocking receive in spawned task)
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

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn export_pdf(
    _app_handle: tauri::AppHandle,
    _html: String,
    _output_path: String,
) -> Result<(), String> {
    Err("PDFエクスポートは現在macOSのみ対応しています".to_string())
}
