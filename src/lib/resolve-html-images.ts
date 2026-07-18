// markdownToHtml 出力 (DOMPurify.sanitize 済み) の img[src] を asset protocol URL に
// 解決する共通ヘルパー。DOMPurify は既定で `scripta-asset:` を弾くため、必ず
// sanitize 後 (=このヘルパーは post-processor として) に適用する。
//
// DOMParser で再パースし img 要素の src 属性だけを書き換えるため、既存 sanitize
// 保証は維持される (テキストノード / 他属性 / KaTeX HTML 等には触らない)。

import { mimeForImageExt } from "../types/image";
import { readFileBase64 } from "./commands";
import { resolveImageSrc, resolveImageToOsPath } from "./image-src";

export function resolveHtmlImageSrcs(html: string, activeTabPath: string | null): string {
	if (!html.includes("<img")) return html;
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const img of doc.body.querySelectorAll("img")) {
		const src = img.getAttribute("src");
		if (!src) continue;
		img.setAttribute("src", resolveImageSrc(src, activeTabPath));
	}
	return doc.body.innerHTML;
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
 * - 画像 3+ 枚は Promise.all で並列読み込み (readFileBase64 は IPC + I/O bound)
 */
export async function embedHtmlImagesAsDataUri(
	html: string,
	activeTabPath: string | null,
): Promise<string> {
	if (!html.includes("<img")) return html;
	const doc = new DOMParser().parseFromString(html, "text/html");
	const imgs = doc.body.querySelectorAll("img");
	if (imgs.length === 0) return html;

	await Promise.all(
		Array.from(imgs, async (img) => {
			const src = img.getAttribute("src");
			if (!src) return;
			const osPath = resolveImageToOsPath(src, activeTabPath);
			if (osPath === null) return;
			const mime = mimeForImageExt(extname(osPath));
			if (mime === null) return;
			try {
				const b64 = await readFileBase64(osPath);
				img.setAttribute("src", `data:${mime};base64,${b64}`);
			} catch {
				// 権限拒否 / 未存在 / サイズ超は broken image として通過させる (HTML 出力自体は完遂)
			}
		}),
	);
	return doc.body.innerHTML;
}
