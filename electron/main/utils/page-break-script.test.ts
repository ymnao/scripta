import { describe, expect, it } from "vitest";
import { buildSectionBreakScript } from "./page-break-script";

describe("buildSectionBreakScript (#93 adaptive)", () => {
	it("IIFE 形式で返す", () => {
		const s = buildSectionBreakScript();
		expect(s.startsWith("(function() {")).toBe(true);
		expect(s.trimEnd().endsWith("})();")).toBe(true);
	});

	it("body 直下 h1〜h6 の出現数を測定する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("document.querySelectorAll('body > h' + lvl)");
		expect(s).toContain("headingCounts");
	});

	it("smartLevel 自動検出: h2 を最優先（複数回現れる最も浅いレベル）", () => {
		const s = buildSectionBreakScript();
		// h2 → h3 → h1 → h4 の優先順
		expect(s).toMatch(/hc\.h2 >= 2/);
		expect(s).toMatch(/hc\.h3 >= 2/);
		expect(s).toMatch(/hc\.h1 >= 2/);
		expect(s).toMatch(/hc\.h4 >= 2/);
	});

	it("smartLevel=null の時は wrap も skip し JSON return", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("smartLevel !== null");
		expect(s).toContain("smartLevelUsed");
	});

	it("renderer 未 wrap でも自前で section を wrap する経路がある", () => {
		const s = buildSectionBreakScript();
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

	it("診断 JSON ({ rendererWrapped, headingCounts, smartLevelUsed, count, broken, errors })", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/rendererWrapped: false/);
		expect(s).toMatch(/headingCounts:/);
		expect(s).toMatch(/smartLevelUsed: null/);
		expect(s).toContain("result.broken++");
		expect(s).toContain("return JSON.stringify(result)");
	});
});
