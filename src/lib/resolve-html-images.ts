// markdownToHtml 出力 (DOMPurify.sanitize 済み) の img[src] を asset protocol URL に
// 解決する共通ヘルパー。DOMPurify は既定で `scripta-asset:` を弾くため、必ず
// sanitize 後 (=このヘルパーは post-processor として) に適用する。
//
// DOMParser で再パースし img 要素の src 属性だけを書き換えるため、既存 sanitize
// 保証は維持される (テキストノード / 他属性 / KaTeX HTML 等には触らない)。

import { resolveImageSrc } from "./image-src";

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
