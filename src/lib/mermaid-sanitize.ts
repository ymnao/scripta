import DOMPurify from "dompurify";

/**
 * Mermaid SVG をサニタイズする。
 * DOMPurify は SVG 内の <foreignObject> の HTML コンテンツを削除してしまうため、
 * SVG 部分と foreignObject 内の HTML を分離してそれぞれサニタイズし、再結合する。
 */
export function sanitizeMermaidSvg(rawSvg: string): string {
	const parser = new DOMParser();
	const serializer = new XMLSerializer();
	const originalDoc = parser.parseFromString(rawSvg, "image/svg+xml");

	// パースエラーの場合は文字列ベースでサニタイズして返す
	if (originalDoc.querySelector("parsererror")) {
		return DOMPurify.sanitize(rawSvg, {
			USE_PROFILES: { svg: true, svgFilters: true },
			ADD_TAGS: ["foreignObject"],
		});
	}

	const originalFOs = originalDoc.querySelectorAll("foreignObject");

	// foreignObject が無い場合は単純にサニタイズ結果を返す
	if (originalFOs.length === 0) {
		return DOMPurify.sanitize(rawSvg, {
			USE_PROFILES: { svg: true, svgFilters: true },
			ADD_TAGS: ["foreignObject"],
		});
	}

	// 各 foreignObject に一意な data 属性を付与し、安定した対応付けを行う
	const originalFoMap = new Map<string, Element>();
	originalFOs.forEach((fo, index) => {
		const id = `fo-${index}`;
		fo.setAttribute("data-fo-id", id);
		originalFoMap.set(id, fo);
	});

	// data-fo-id を埋め込んだ SVG を XMLSerializer で文字列化し DOMPurify でサニタイズ
	const svgWithIds = serializer.serializeToString(originalDoc.documentElement);
	const sanitized = DOMPurify.sanitize(svgWithIds, {
		USE_PROFILES: { svg: true, svgFilters: true },
		ADD_TAGS: ["foreignObject"],
		ADD_ATTR: ["data-fo-id"],
	});

	// サニタイズ済み SVG を再パースし、foreignObject 内の HTML を個別にサニタイズして再注入
	const sanitizedDoc = parser.parseFromString(sanitized, "image/svg+xml");
	const sanitizedFOs = sanitizedDoc.querySelectorAll("foreignObject");

	for (const fo of sanitizedFOs) {
		const id = fo.getAttribute("data-fo-id");
		if (!id) continue;
		const originalFO = originalFoMap.get(id);
		if (!originalFO) continue;
		const foContent = DOMPurify.sanitize(originalFO.innerHTML, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
			FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
		});
		fo.innerHTML = foContent;
		fo.removeAttribute("data-fo-id");
	}

	return serializer.serializeToString(sanitizedDoc.documentElement);
}
