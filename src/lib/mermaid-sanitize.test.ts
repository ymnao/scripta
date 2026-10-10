import { describe, expect, it } from "vitest";
import { sanitizeMermaidSvg } from "./mermaid-sanitize";

const MERMAID_SVG = `<svg id="mermaid-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" style="max-width: 200px;">
<style>#mermaid-0 { font-family: sans-serif; } .messageText { font-size: 16px; fill: #333; }</style>
<g>
<rect x="10" y="10" width="180" height="40" class="node"/>
<foreignObject x="10" y="10" width="180" height="40">
<div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: center; justify-content: center; width: 180px; height: 40px;">
<span class="label" style="color: #333;">Hello World</span>
</div>
</foreignObject>
</g>
</svg>`;

// Chromium の mermaid 12 が `A["1行目<br/>2行目"]` に対して実際に出力する形 (閉じない <br>)
const BR_LABEL_SVG = `<svg id="mermaid-1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 42"><g class="label"><foreignObject width="120" height="42"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table; white-space: nowrap; line-height: 1.5;"><span class="nodeLabel"><p>1行目<br>2行目</p></span></div></foreignObject></g></svg>`;

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function labelParagraph(svg: string): HTMLParagraphElement {
	const template = document.createElement("template");
	template.innerHTML = svg;
	const p = template.content.querySelector("foreignObject p");
	if (!(p instanceof HTMLParagraphElement)) throw new Error("label <p> not found");
	return p;
}

describe("sanitizeMermaidSvg", () => {
	describe("ラベル内の <br>", () => {
		it("閉じない <br> を含むラベルの改行を保持する", () => {
			const p = labelParagraph(sanitizeMermaidSvg(BR_LABEL_SVG));
			expect(Array.from(p.childNodes, (n) => n.nodeName)).toEqual(["#text", "BR", "#text"]);
			expect(p.textContent).toBe("1行目2行目");
		});

		it("<br> を XHTML namespace の要素として出力する", () => {
			const doc = new DOMParser().parseFromString(
				sanitizeMermaidSvg(BR_LABEL_SVG),
				"image/svg+xml",
			);
			expect(doc.getElementsByTagName("br")[0]?.namespaceURI).toBe(XHTML_NS);
		});

		it("閉じた <br/> を含むラベルでも改行を保持する", () => {
			const p = labelParagraph(sanitizeMermaidSvg(BR_LABEL_SVG.replace("<br>", "<br/>")));
			expect(Array.from(p.childNodes, (n) => n.nodeName)).toEqual(["#text", "BR", "#text"]);
		});

		it("出力は XML として parse できる", () => {
			const doc = new DOMParser().parseFromString(
				sanitizeMermaidSvg(BR_LABEL_SVG),
				"image/svg+xml",
			);
			expect(doc.querySelector("parsererror")).toBeNull();
		});

		it("<br> を含むラベルでも foreignObject 内の script / on* / javascript: を除去する", () => {
			const malicious = BR_LABEL_SVG.replace(
				"<p>1行目",
				'<p onclick="alert(1)">1行目<script>alert(1)</script><a href="javascript:alert(1)">x</a>',
			);
			const result = sanitizeMermaidSvg(malicious);
			expect(result).toContain("<br");
			expect(result).not.toContain("<script");
			expect(result).not.toContain("onclick");
			expect(result).not.toContain("javascript:");
		});
	});

	it("foreignObject 内の HTML テキストを保持する", () => {
		const result = sanitizeMermaidSvg(MERMAID_SVG);
		expect(result).toContain("foreignObject");
		expect(result).toContain("Hello World");
		expect(result).toContain("<span");
		expect(result).toContain("<div");
	});

	it("SVG の style 要素を保持する", () => {
		const result = sanitizeMermaidSvg(MERMAID_SVG);
		expect(result).toContain("<style>");
		expect(result).toContain(".messageText");
	});

	it("foreignObject 内の script タグを除去する", () => {
		const malicious = MERMAID_SVG.replace(
			"Hello World",
			'Hello <script>alert("xss")</script>World',
		);
		const result = sanitizeMermaidSvg(malicious);
		expect(result).not.toContain("<script");
		expect(result).toContain("Hello");
	});

	it("root に xmlns:xlink の宣言が無くても xlink:href を保持する", () => {
		// mermaid 12 は click リンクを xlink:href で出すが root に xmlns:xlink を宣言しない
		const linked = BR_LABEL_SVG.replace(
			'<g class="label">',
			'<a xlink:href="https://example.com"><g class="label">',
		).replace("</g></svg>", "</g></a></svg>");
		expect(sanitizeMermaidSvg(linked)).toContain('xlink:href="https://example.com"');
	});

	it("foreignObject 外の script / on* を除去する", () => {
		const malicious = MERMAID_SVG.replace(
			'<rect x="10"',
			'<script>alert(1)</script><rect onload="alert(1)" x="10"',
		);
		const result = sanitizeMermaidSvg(malicious);
		expect(result).not.toContain("<script");
		expect(result).not.toContain("onload");
		expect(result).toContain("Hello World");
	});

	it("foreignObject がない SVG はそのままサニタイズする", () => {
		const simple =
			'<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="100"/></svg>';
		const result = sanitizeMermaidSvg(simple);
		expect(result).toContain("<rect");
		expect(result).not.toContain("foreignObject");
	});

	it("イベントハンドラ属性を除去する", () => {
		const malicious = MERMAID_SVG.replace('class="label"', 'class="label" onerror="alert(1)"');
		const result = sanitizeMermaidSvg(malicious);
		expect(result).not.toContain("onerror");
		expect(result).toContain("Hello World");
	});

	it("複数の foreignObject を data-fo-id で安定的に対応付ける", () => {
		const multiSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
<g>
<foreignObject x="0" y="0" width="180" height="40">
<div xmlns="http://www.w3.org/1999/xhtml"><span>First</span></div>
</foreignObject>
<foreignObject x="200" y="0" width="180" height="40">
<div xmlns="http://www.w3.org/1999/xhtml"><span>Second</span></div>
</foreignObject>
</g>
</svg>`;
		const result = sanitizeMermaidSvg(multiSvg);
		expect(result).toContain("First");
		expect(result).toContain("Second");
		// data-fo-id はサニタイズ後に除去される
		expect(result).not.toContain("data-fo-id");
	});

	it("サニタイズ後に data-fo-id 属性が残らない", () => {
		const result = sanitizeMermaidSvg(MERMAID_SVG);
		expect(result).not.toContain("data-fo-id");
	});

	it("SVG 要素の style 属性（max-width 等）を保持する", () => {
		const result = sanitizeMermaidSvg(MERMAID_SVG);
		expect(result).toContain("max-width");
	});

	it("text-anchor 属性とインラインスタイルを保持する", () => {
		// promoteMermaidStyles 廃止後はサニタイズ出力がそのまま描画されるため、
		// text-anchor（テキスト揃え）がサニタイズで失われないことを保証する。
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" id="mermaid-0">
<text text-anchor="middle" x="100" y="50">Hello</text>
<text style="text-anchor: middle; font-size: 14px" x="300" y="50">Styled</text>
</svg>`;
		const result = sanitizeMermaidSvg(svg);
		// 属性形式（1 つ目の <text>）— XMLSerializer の出力は安定
		expect(result).toContain('text-anchor="middle"');
		// インラインスタイル形式（2 つ目の <text>）— DOMPurify / シリアライザの
		// 空白正規化（`text-anchor:middle` 等）で壊れないよう宣言の存在を regex で検証
		expect(result).toMatch(/text-anchor\s*:\s*middle/);
	});
});
