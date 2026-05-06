import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import writeFileAtomic from "write-file-atomic";
import { assertWritePathAllowed, consumeTransientWritePath } from "../utils/path-guard";

// 旧 Tauri 版 src-tauri/src/commands/export.rs を Electron `webContents.printToPDF` に
// 置き換える。Tauri 版は macOS / Windows それぞれ AppKit / WebView2 native API で
// PDF を生成していたが、Electron は Chromium の printToPDF で OS 依存なし。
//
// セキュリティ:
// - outputPath は `assertWritePathAllowed(senderId, outputPath)` で検証する。
//   通常は dialog:save 経由の transient capability のみが workspace 外への書き込みを
//   許可される（registerTransientWritePath / consumeTransientWritePath）。
// - 隠し BrowserWindow は **専用 partition** で作る。main session には CSP ヘッダを
//   inject する webRequest hook が登録されているため、PDF 用 HTML 内の
//   `<script>` タグ（旧版の動的ページブレーク等）が strip されないようにする。
//
// 動作:
// 1. HTML を temp file に書き、隠し BrowserWindow に file:// URL で load
// 2. did-finish-load を待ち、`document.fonts.ready` でカスタムフォント (KaTeX 等)
//    の読み込み完了を確認、加えて短時間 idle で DOM を安定化
// 3. printToPDF で Buffer を取得し、write-file-atomic で原子的に書き出す
// 4. transient capability を consume し、temp file / window を必ず破棄

const PDF_PARTITION = "scripta-pdf-export";
const PDF_LOAD_TIMEOUT_MS = 30_000;
const POST_LOAD_IDLE_MS = 100;

// A4 サイズ + 20mm マージン（旧 Rust impl と同値、inch 換算: 20mm ≈ 0.787in）。
const PDF_OPTIONS = {
	pageSize: "A4" as const,
	margins: {
		top: 0.787,
		bottom: 0.787,
		left: 0.787,
		right: 0.787,
	},
	printBackground: true,
	scale: 1.0,
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function exportPdfImpl(
	senderId: number,
	html: string,
	outputPath: string,
): Promise<void> {
	const canonical = assertWritePathAllowed(senderId, outputPath);

	const tmpDirPath = await fsp.mkdtemp(join(tmpdir(), "scripta-pdf-"));
	const tmpHtmlPath = join(tmpDirPath, "export.html");
	await fsp.writeFile(tmpHtmlPath, html, "utf8");

	let win: BrowserWindow | null = null;
	try {
		win = new BrowserWindow({
			width: 800,
			height: 600,
			show: false,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				partition: PDF_PARTITION,
			},
		});

		const loadPromise = win.loadFile(tmpHtmlPath);
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("PDFエクスポートのページ読み込みがタイムアウトしました")),
				PDF_LOAD_TIMEOUT_MS,
			),
		);
		await Promise.race([loadPromise, timeoutPromise]);

		// KaTeX 等のカスタムフォントが load 完了するのを待つ。document.fonts API が
		// 無い環境（古い Chromium など）でも壊れないよう try/catch でガード。
		try {
			await win.webContents.executeJavaScript(
				`(typeof document !== "undefined" && document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true)`,
				true,
			);
		} catch {
			// ignore
		}
		await delay(POST_LOAD_IDLE_MS);

		const buffer = await win.webContents.printToPDF(PDF_OPTIONS);
		if (buffer.length === 0) {
			throw new Error("PDFファイルが空です");
		}

		await writeFileAtomic(canonical, buffer);
		consumeTransientWritePath(senderId, canonical);
	} finally {
		if (win && !win.isDestroyed()) win.destroy();
		await fsp.rm(tmpDirPath, { recursive: true, force: true }).catch(() => {});
	}
}

export function registerPdfIpc(): void {
	ipcMain.handle(
		"pdf:export",
		(event, html: string, outputPath: string): Promise<void> =>
			exportPdfImpl(event.sender.id, html, outputPath),
	);
}

export const __testing = { exportPdfImpl };
