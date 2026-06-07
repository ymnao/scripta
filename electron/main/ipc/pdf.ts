import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, session } from "electron";
import writeFileAtomic from "write-file-atomic";
import { handle } from "../utils/ipc-handle";
import { buildSectionBreakScript } from "../utils/page-break-script";
import { assertWritePathAllowed, consumeTransientWritePath } from "../utils/path-guard";
import { isGlobalIp } from "../utils/ssrf-guard";

// Electron `webContents.printToPDF`（Chromium）で PDF を生成する。OS 依存の
// native API は使わない。
//
// セキュリティ:
// - outputPath は `assertWritePathAllowed(senderId, outputPath)` で検証する。
//   通常は dialog:save 経由の transient capability のみが workspace 外への書き込みを
//   許可される（registerTransientWritePath / consumeTransientWritePath）。
// - 隠し BrowserWindow は **専用 partition** で作る。main session には CSP ヘッダを
//   inject する webRequest hook が登録されているため、PDF 用 HTML 内の
//   `<script>` タグ（動的ページブレーク等）が strip されないようにする。
// - 専用 partition の session には webRequest フィルタを 1 度だけ登録し、
//   PDF レンダリング中の **subresource fetch を SSRF-safe に制限** する:
//   - `http:` は完全遮断（スキーム allowlist で `https:` / `data:` / `file:` のみ）
//   - IP literal の hostname は `isGlobalIp` で判定し、private / loopback /
//     link-local（クラウドメタデータ 169.254.169.254 等）への接続を弾く
//   - `file:` は OS の tmpdir 配下のみ許可（PDF 用 temp HTML 経路）
//   ホスト名の DNS 解決時 SSRF（rebinding 等）は Chromium 内部の DNS まで届かない
//   ため URL 段階での best effort 防御に留まる。OGP fetch 側の `safeLookup` と異なり
//   完全な TOCTOU 防御ではないが、典型的な metadata 直撃 / `http://` 経由攻撃を弾く。
//
// 動作:
// 1. HTML を temp file に書き、隠し BrowserWindow に file:// URL で load
// 2. did-finish-load を待ち、`document.fonts.ready` でカスタムフォント (KaTeX 等)
//    の読み込み完了を確認、加えて短時間 idle で DOM を安定化
// 3. printToPDF で Buffer を取得し、write-file-atomic で原子的に書き出す
// 4. transient capability を consume し、temp file / window を必ず破棄

const PDF_PARTITION = "scripta-pdf-export";
// **export 全体** の上限。loadFile / fonts.ready / printToPDF を 1 つの予算で見て、
// 「重いが正常な文書」を誤 timeout させず、「load 後にハング」を永遠に待たない。
// export 全体に 5 分（300s）の予算を割り当てる。
const PDF_EXPORT_TIMEOUT_MS = 300_000;
const POST_LOAD_IDLE_MS = 100;

// PDF 用 partition の webRequest フィルタは process 寿命中 1 度だけ登録すれば
// 良い（同じ partition 文字列は同じ session を返す）。多重 install を避けるための flag。
let pdfWebRequestFilterInstalled = false;

// PDF レンダリング window から発生する subresource fetch をフィルタする。
// fast-path で典型的な SSRF / 危険スキームを弾く設計（DNS レベル防御は Chromium
// 内部に届かないため不可、ここではあくまで URL 文字列ベースの best effort）。
function shouldAllowPdfRequest(rawUrl: string): boolean {
	// devtools / about:blank 等は許可（renderer の正常動作に必要なケースがある）。
	if (rawUrl === "about:blank") return true;
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return false;
	}
	const protocol = parsed.protocol;
	if (protocol === "data:") return true;
	if (protocol === "file:") {
		// PDF 用 temp HTML は OS の tmpdir 配下に作るので、それ以外への file: 参照は弾く。
		// `URL.pathname` は POSIX 表現（Windows でも `/C:/...`）になる一方、`tmpdir()`
		// は OS ネイティブ表現（Windows なら `C:\...`）。素朴に startsWith で比較すると
		// Windows でメインフレームのロード自体（loadFile が file:///C:/... を発行する）
		// まで弾いて pdf:export がタイムアウトするため、`fileURLToPath` で URL 側を
		// OS ネイティブに正規化してから path.sep ベースで比較する。
		let osPath: string;
		try {
			osPath = fileURLToPath(rawUrl);
		} catch {
			return false;
		}
		const tmpRoot = tmpdir();
		return osPath === tmpRoot || osPath.startsWith(`${tmpRoot}${sep}`);
	}
	if (protocol !== "https:") {
		// `http:` は SSRF リスクが高いので拒否（暗号化 + 認証された送信のみ許す）。
		// `chrome:` / `chrome-extension:` 等の特殊 scheme もここで弾く。
		return false;
	}
	// hostname が IP literal の場合は global のみ許可。`new URL` は IPv6 リテラルを
	// `[...]` で囲んだ表記で hostname を返す（zone id は drop）ので前後の `[]` を外す。
	let host = parsed.hostname;
	if (host.startsWith("[") && host.endsWith("]")) {
		host = host.slice(1, -1);
	}
	const looksIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
	const looksIpv6 = host.includes(":");
	if (looksIpv4 || looksIpv6) {
		return isGlobalIp(host);
	}
	// hostname がドメイン名のときは Chromium 内部の DNS 解決時には介入できない。
	// 名前ベースの SSRF（例: `internal.corp` が private に解決）は防げないが、
	// 典型的な攻撃ベクトルである literal IP / `http:` / metadata service は遮断した。
	return true;
}

function installPdfWebRequestFilter(): void {
	if (pdfWebRequestFilterInstalled) return;
	const pdfSession = session.fromPartition(PDF_PARTITION);
	pdfSession.webRequest.onBeforeRequest((details, callback) => {
		callback({ cancel: !shouldAllowPdfRequest(details.url) });
	});
	pdfWebRequestFilterInstalled = true;
}

// A4 サイズ + 20mm マージン。Electron の printToPDF は
// margins を inches で要求するため mm から換算する（1 inch = 25.4 mm）。
const PDF_MARGIN_MM = 20;
const PDF_MARGIN_INCHES = PDF_MARGIN_MM / 25.4;
const PDF_OPTIONS = {
	pageSize: "A4" as const,
	margins: {
		top: PDF_MARGIN_INCHES,
		bottom: PDF_MARGIN_INCHES,
		left: PDF_MARGIN_INCHES,
		right: PDF_MARGIN_INCHES,
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
	const canonical = await assertWritePathAllowed(senderId, outputPath);

	// session.fromPartition は app ready 後でないと動かないため、IPC 受信時 (=必ず
	// app ready 後) に lazy install する。多重 install は flag で防止。
	installPdfWebRequestFilter();

	const tmpDirPath = await fsp.mkdtemp(join(tmpdir(), "scripta-pdf-"));
	const tmpHtmlPath = join(tmpDirPath, "export.html");
	await fsp.writeFile(tmpHtmlPath, html, "utf8");

	// 診断用: 環境変数 `SCRIPTA_PDF_DEBUG_HTML_PATH` がセットされていれば、
	// printToPDF に渡される最終 HTML を指定 path にコピーする。#106 のような
	// PDF 内描画問題で「実際に何が WebView に届いているか」を取り出すための
	// debug hook。本番では env を設定しないので no-op。
	const debugHtmlPath = process.env.SCRIPTA_PDF_DEBUG_HTML_PATH;
	if (debugHtmlPath) {
		await fsp.writeFile(debugHtmlPath, html, "utf8").catch((err) => {
			console.error("[scripta:pdf-debug] HTML write failed:", err);
		});
	}

	let win: BrowserWindow | null = null;
	let timeoutId: NodeJS.Timeout | undefined;
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
		const w = win;

		// 「load → fonts.ready → idle → printToPDF」の各段に **個別の** タイムアウトを
		// 持たせると、重いが正常な文書を early-timeout してしまう一方で「load 後に
		// 固まる」ケースは無期限に待つという非対称な失敗モードになる。export 全体に
		// 1 個の予算（PDF_EXPORT_TIMEOUT_MS = 300s）をかける。
		const exportWork = (async (): Promise<Buffer> => {
			await w.loadFile(tmpHtmlPath);
			// KaTeX 等のカスタムフォントが load 完了するのを待つ。document.fonts API が
			// 無い環境（古い Chromium など）でも壊れないよう try/catch でガード。
			try {
				await w.webContents.executeJavaScript(
					`(typeof document !== "undefined" && document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true)`,
					true,
				);
			} catch {
				// ignore
			}
			await delay(POST_LOAD_IDLE_MS);

			// Section の改ページ判定: 見出しに直接 inline `break-before: page` を注入する
			// 方式 (#93)。wrapper への `break-inside: avoid` は Chromium で overcaution
			// を起こす quirk (#601033) があり、inline forced break の方が確実。
			// 診断ログは `SCRIPTA_PDF_DEBUG` 環境変数を立てた時だけ出力する。
			try {
				const diag = (await w.webContents.executeJavaScript(
					buildSectionBreakScript(),
					true,
				)) as string;
				if (process.env.SCRIPTA_PDF_DEBUG) {
					process.stderr.write(
						`[scripta:#93] break-before script: ${diag} (html ${html.length} bytes)\n`,
					);
				}
			} catch (err) {
				console.warn("[scripta:#93] break-before correction failed:", err);
			}
			return await w.webContents.printToPDF(PDF_OPTIONS);
		})();
		// timeout が race に勝った後 exportWork が遅れて reject すると unhandled
		// rejection になるので、最終的な結果を捨てる no-op handler を attach する。
		exportWork.catch(() => {});

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(
				() => reject(new Error("PDFエクスポートがタイムアウトしました")),
				PDF_EXPORT_TIMEOUT_MS,
			);
		});

		const buffer = await Promise.race([exportWork, timeoutPromise]);
		if (buffer.length === 0) {
			throw new Error("PDFファイルが空です");
		}

		await writeFileAtomic(canonical, buffer);
		consumeTransientWritePath(senderId, canonical);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		if (win && !win.isDestroyed()) win.destroy();
		await fsp.rm(tmpDirPath, { recursive: true, force: true }).catch(() => {});
	}
}

export function registerPdfIpc(): void {
	handle(
		"pdf:export",
		(event, html: string, outputPath: string): Promise<void> =>
			exportPdfImpl(event.sender.id, html, outputPath),
	);
}

export const __testing = { exportPdfImpl, shouldAllowPdfRequest };
