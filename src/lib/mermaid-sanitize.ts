import DOMPurify from "dompurify";

const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const SVG_PURIFY_CONFIG = {
	USE_PROFILES: { svg: true, svgFilters: true },
	ADD_TAGS: ["foreignObject"],
};

function parseSvgAsHtml(markup: string): SVGSVGElement | null {
	return new DOMParser().parseFromString(markup, "text/html").body.querySelector("svg");
}

/**
 * Mermaid SVG をサニタイズする。
 * DOMPurify は SVG 内の <foreignObject> の HTML コンテンツを削除してしまうため、
 * SVG 部分と foreignObject 内の HTML を分離してそれぞれサニタイズし、再結合する。
 */
export function sanitizeMermaidSvg(rawSvg: string): string {
	// image/svg+xml で parse しないのは、Chromium の mermaid がラベルの改行を閉じない
	// <br> で出力し XML として壊れているため。組み立ても HTML document 上で行うのは、
	// XML document の要素への innerHTML 代入は HTML 直列化された <br> で SyntaxError になるため。
	const originalSvg = parseSvgAsHtml(rawSvg);
	const originalFOs = originalSvg?.querySelectorAll("foreignObject");
	if (!originalSvg || !originalFOs?.length) {
		return DOMPurify.sanitize(rawSvg, SVG_PURIFY_CONFIG);
	}

	// 各 foreignObject に一意な data 属性を付与し、安定した対応付けを行う
	const originalFoHtml = new Map<string, string>();
	originalFOs.forEach((fo, index) => {
		const id = `fo-${index}`;
		fo.setAttribute("data-fo-id", id);
		originalFoHtml.set(id, fo.innerHTML);
	});

	// mermaid は root に xmlns:xlink を宣言しないまま xlink:href (click リンク等) を出す。
	// 未宣言だと XMLSerializer が ns1:href のような prefix を生成し、DOMPurify に落とされる。
	originalSvg.setAttributeNS(XMLNS_NS, "xmlns:xlink", XLINK_NS);
	const serializer = new XMLSerializer();
	const sanitized = DOMPurify.sanitize(serializer.serializeToString(originalSvg), {
		...SVG_PURIFY_CONFIG,
		ADD_ATTR: ["data-fo-id"],
	});
	const sanitizedSvg = parseSvgAsHtml(sanitized);
	if (!sanitizedSvg) return sanitized;

	// サニタイズ済み SVG の foreignObject に、個別にサニタイズした HTML を再注入する。
	// xmlns を落とすのは、HTML document 上では名前空間の無いただの属性として残り、
	// XMLSerializer が名前空間宣言と二重に書いて XML として壊れるため。
	for (const fo of sanitizedSvg.querySelectorAll("foreignObject")) {
		const html = originalFoHtml.get(fo.getAttribute("data-fo-id") ?? "");
		fo.removeAttribute("data-fo-id");
		if (html === undefined) continue;
		fo.innerHTML = DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
			FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "xmlns"],
		});
	}

	return serializer.serializeToString(sanitizedSvg);
}
