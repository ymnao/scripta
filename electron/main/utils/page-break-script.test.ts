import { describe, expect, it } from "vitest";
import { buildSectionBreakScript } from "./page-break-script";

describe("buildSectionBreakScript (#93 hybrid + main-side wrap)", () => {
	it("IIFE 形式で返す", () => {
		const s = buildSectionBreakScript();
		expect(s.startsWith("(function() {")).toBe(true);
		expect(s.trimEnd().endsWith("})();")).toBe(true);
	});

	it("default smartLevel=2 が埋め込まれる", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("var SMART_LEVEL = 2;");
	});

	it("smartLevel を引数で変更できる", () => {
		const s3 = buildSectionBreakScript(3);
		expect(s3).toContain("var SMART_LEVEL = 3;");
	});

	it("renderer 未 wrap でも自前で section を wrap する経路がある", () => {
		const s = buildSectionBreakScript();
		// 自前 wrap の判定: rendererWrapped が false かつ h2 がある時
		expect(s).toContain("rendererWrapped");
		expect(s).toContain("section.className = 'pdf-section-keep'");
		expect(s).toContain("section.appendChild(cur)");
	});

	it("section の CSS (break-inside: avoid-page) も script から inject する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain(".pdf-section-keep { break-inside: avoid-page");
		expect(s).toContain("page-break-inside: avoid");
	});

	it("印刷幅 170mm へ body を一時揃える", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("(170 / zoom) + 'mm'");
	});

	it("ページ高さは 257mm ルーラーで実測する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("height:257mm");
	});

	it("safety buffer (20%) で screen ⇔ print の layout drift を吸収する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("pageHeight * 0.20");
	});

	it("section がページ境界をまたぐ条件で breakBefore = 'page' を inline 注入する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("item.style.breakBefore = 'page'");
		expect(s).toContain("item.style.pageBreakBefore = 'always'");
	});

	it("hr.pdf-pagebreak 著者マーカーで virtualY を次ページ頭へジャンプする", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("'pdf-pagebreak'");
		expect(s).toContain("pageHeight - inPageMarker");
	});

	it("診断 JSON ({ rendererWrapped, h2Count, count, broken, errors }) を返す", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/rendererWrapped: false/);
		expect(s).toMatch(/h2Count: 0/);
		expect(s).toContain("result.broken++");
		expect(s).toContain("return JSON.stringify(result)");
	});

	it("body style を try/finally で restore する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("} finally {");
		expect(s).toContain("document.body.style.padding = origPadding");
	});
});
