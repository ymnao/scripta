import { describe, expect, it } from "vitest";
import { sanitizeMermaidSvg } from "./mermaid";

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

describe("sanitizeMermaidSvg", () => {
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
});
