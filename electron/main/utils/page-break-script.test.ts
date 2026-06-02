import { describe, expect, it } from "vitest";
import { buildSectionBreakScript } from "./page-break-script";

describe("buildSectionBreakScript (#93 hybrid)", () => {
	it("IIFE 形式で返す", () => {
		const s = buildSectionBreakScript();
		expect(s.startsWith("(function() {")).toBe(true);
		expect(s.trimEnd().endsWith("})();")).toBe(true);
	});

	it("セクション 0 件は早期 return（無駄な計測しない）", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/sections\.length === 0[^;]*return/);
	});

	it("印刷幅 170mm へ body を一時揃える", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("(170 / zoom) + 'mm'");
	});

	it("ページ高さは 257mm ルーラーで実測する (A4 - 上下 20mm margin)", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("height:257mm");
	});

	it("section がページ境界をまたぐ条件で breakBefore = 'page' を inline 注入する", () => {
		const s = buildSectionBreakScript();
		// 残量に収まらず、1 ページに収まる、かつ既にページ途中
		expect(s).toMatch(/height > remaining[\s\S]*?height <= pageHeight[\s\S]*?inPage > 0/);
		expect(s).toContain("item.style.breakBefore = 'page'");
		expect(s).toContain("item.style.pageBreakBefore = 'always'");
	});

	it("hr.pdf-pagebreak 著者マーカーで virtualY を次ページ頭へジャンプする", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("'pdf-pagebreak'");
		expect(s).toContain("pageHeight - inPageMarker");
	});

	it("body style を try/finally で restore する (例外でも壊れない)", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("try {");
		expect(s).toContain("} finally {");
		expect(s).toContain("document.body.style.padding = origPadding");
		expect(s).toContain("document.body.style.width = origWidth");
		expect(s).toContain("document.body.style.maxWidth = origMaxWidth");
	});

	it("pre を pre-wrap に切り替えて印刷折り返しを再現する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("white-space: pre-wrap !important");
		expect(s).toContain("word-wrap: break-word !important");
	});
});
