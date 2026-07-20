// markdownToHtmlRaw 出力 (sanitize 未実施) の img[src] を asset protocol URL に
// 解決する共通ヘルパー。sanitize-after pattern (session 115) では、この関数が返す
// `UnsanitizedHtml` を caller が `finalizeHtml({ allowAssetProtocol: true })` に
// 通して初めて plain string の sink 用 HTML になる。
//
// DOMParser で再パースし img 要素の src 属性だけを書き換える (テキストノード /
// 他属性 / KaTeX HTML 等には触らない)。sanitize は後段で 1 度だけ実施される。

import { mimeForImageExt } from "../types/image";
import { readFileBase64 } from "./commands";
import { markUnsanitized, type UnsanitizedHtml } from "./finalize-html";
import { resolveImageSrc, resolveImageToOsPath } from "./image-src";

export function resolveHtmlImageSrcs(
	html: UnsanitizedHtml,
	activeTabPath: string | null,
): UnsanitizedHtml {
	if (!html.includes("<img")) return html;
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const img of doc.body.querySelectorAll("img")) {
		const src = img.getAttribute("src");
		if (!src) continue;
		img.setAttribute("src", resolveImageSrc(src, activeTabPath));
	}
	return markUnsanitized(doc.body.innerHTML);
}

/** 拡張子を末尾から抜き出す (先頭ドット付き、無ければ空文字)。path-lite; node:path/extname 依存を持ちたくないので独自実装。 */
function extname(p: string): string {
	const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	const dot = p.lastIndexOf(".");
	if (dot === -1 || dot < slash) return "";
	// 隠しファイル ".env" (dot at basename start) は拡張子扱いしない
	if (dot === slash + 1) return "";
	return p.slice(dot);
}

// exportAsHtml 経路で main 側の Buffer.alloc 同時発生数と、renderer 側の base64 文字列
// 保持ピークを両方バウンドする concurrency 上限。1 画像あたり最大 MAX_READ_FILE_BYTES
// (64MB) の Buffer.alloc が走るため、上限 4 でも main メモリの一時ピークは ~256MB に
// 抑えられる。IPC は main event loop 単スレッド直列化なので K を上げても wall-clock は
// ほぼ改善しない (K=4 で十分)。
const EMBED_CONCURRENCY = 4;

// exportAsHtml 経路で HTML 内に埋め込む base64 文字列の合計サイズ上限 (#354)。
// 個別ファイルは main 側で 64MB に bound しているが、極端に画像が多い文書 (例: 500
// 個の 63MB PNG) で累積が V8 heap を圧迫し renderer OOM を招くリスクが残っていた。
// 累積が超過した以降の画像は data URI 化を skip し、元 src (scripta-asset URL 等) を
// 維持する。上限は base64 文字列長で 256MB (実画像換算 ~192MB)。
const TOTAL_EMBED_BYTES_LIMIT = 256 * 1024 * 1024;

/**
 * `resolveHtmlImageSrcs` の async 版。ローカル画像を data URI で HTML に埋め込む (#314)。
 *
 * 外部ブラウザで HTML を開いても画像が壊れないことを目的にした exportAsHtml 用の
 * post-processor。呼び出し順は「markdownToHtml → embedHtmlImagesAsDataUri → HTML 出力」。
 *
 * 挙動:
 * - http(s) / data: / blob: の src はそのまま維持 (fetch しない)
 * - 未対応拡張子 (video 等) はそのまま維持
 * - `readFileBase64` が throw (workspace 外 / 見つからない / サイズ超) した場合も
 *   元の src を残す (broken image になるが export 自体は失敗させない)
 * - 同一 osPath は 1 回だけ read し、複数 img に data URI を再利用 (メモリ + IPC 節約)
 * - 並列度は EMBED_CONCURRENCY で bound (multi-image 悪意 md による OOM 抑止)
 * - 埋め込み base64 の累積長が TOTAL_EMBED_BYTES_LIMIT を超えた以降は data URI 化せず
 *   元 src を維持 (#354 renderer OOM 対策)。cap 到達時にどの画像が skip されるかは
 *   I/O 完了順に依存する
 */
export async function embedHtmlImagesAsDataUri(
	html: UnsanitizedHtml,
	activeTabPath: string | null,
): Promise<UnsanitizedHtml> {
	if (!html.includes("<img")) return html;
	const doc = new DOMParser().parseFromString(html, "text/html");
	const imgs = doc.body.querySelectorAll("img");
	if (imgs.length === 0) return html;

	// 1st pass: 同一 osPath ごとに fetch 対象を dedup。src が同じ画像を N 回参照する
	// 文書でも I/O + Buffer.alloc は 1 回で済む。
	type Task = { osPath: string; mime: string; targets: Element[] };
	const tasks = new Map<string, Task>();
	for (const img of imgs) {
		const src = img.getAttribute("src");
		if (!src) continue;
		const osPath = resolveImageToOsPath(src, activeTabPath);
		if (osPath === null) continue;
		const mime = mimeForImageExt(extname(osPath));
		if (mime === null) continue;
		const key = `${mime}:${osPath}`;
		const existing = tasks.get(key);
		if (existing) {
			existing.targets.push(img);
		} else {
			tasks.set(key, { osPath, mime, targets: [img] });
		}
	}
	if (tasks.size === 0) return html;

	// 2nd pass: worker pool で bounded concurrency の Task 消化。
	// 単純な batched Promise.all だと slow-image が同 batch の fast-image を待たせる
	// 頭打ちが出るので、queue から順に pull する worker 型を採用。
	const queue = [...tasks.values()];
	let next = 0;
	let totalEmbeddedBytes = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const i = next++;
			if (i >= queue.length) return;
			const task = queue[i];
			try {
				const b64 = await readFileBase64(task.osPath);
				// 累積上限を超える場合は data URI 化せず元 src を維持 (broken image と同じ扱いで
				// export 自体は完遂)。JS は単スレッドで check → += の間に await が無いため
				// 他 worker が割り込む余地は無く、実オーバーシュートは発生しない。
				if (totalEmbeddedBytes + b64.length > TOTAL_EMBED_BYTES_LIMIT) continue;
				totalEmbeddedBytes += b64.length;
				const dataUri = `data:${task.mime};base64,${b64}`;
				for (const target of task.targets) target.setAttribute("src", dataUri);
			} catch {
				// 権限拒否 / 未存在 / サイズ超は broken image として通過させる (HTML 出力自体は完遂)
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(EMBED_CONCURRENCY, queue.length) }, () => worker()),
	);
	return markUnsanitized(doc.body.innerHTML);
}
