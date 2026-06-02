import { describe, expect, it } from "vitest";
import { buildSectionBreakScript } from "./page-break-script";

describe("buildSectionBreakScript (#93 v5 inline break-before)", () => {
	it("IIFE 形式で返す", () => {
		const s = buildSectionBreakScript();
		expect(s.startsWith("(function() {")).toBe(true);
		expect(s.trimEnd().endsWith("})();")).toBe(true);
	});

	it("`.pdf-section-keep` wrapper を unwrap する (overcaution 源の排除)", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("document.querySelectorAll('.pdf-section-keep')");
		expect(s).toContain("p.insertBefore(w.firstChild, w)");
		expect(s).toContain("p.removeChild(w)");
	});

	it("body 直下 h1〜h6 の出現数を測定する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("document.querySelectorAll('body > h' + lvl)");
	});

	it("smartLevel 自動検出: h2 > h3 > h1 > h4 の優先順", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/hc\.h2 >= 2/);
		expect(s).toMatch(/hc\.h3 >= 2/);
		expect(s).toMatch(/hc\.h1 >= 2/);
		expect(s).toMatch(/hc\.h4 >= 2/);
	});

	it("印刷幅 170mm へ body を一時揃える", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("(170 / zoom) + 'mm'");
	});

	it("ページ高さは 257mm ルーラーで実測する (A4 - 上下 20mm margin)", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("height:257mm");
	});

	it("safety buffer (15%) で screen ⇔ print の layout drift を吸収する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("pageHeight * 0.15");
	});

	it("section が現ページに収まらない時、見出し自身に inline break-before を注入する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("item.style.breakBefore = 'page'");
		expect(s).toContain("item.style.pageBreakBefore = 'always'");
		expect(s).toMatch(/sectionH \+ safetyBuffer/);
	});

	it("section 範囲は次の同位以下見出し or HR pagebreak まで", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("nxLvl <= smartLevel");
		expect(s).toContain("'pdf-pagebreak'");
	});

	it("hr.pdf-pagebreak 著者マーカーで virtualY を次ページ頭へジャンプする", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("pageHeight - inPageMarker");
	});

	it("診断 JSON: unwrapped / headingCounts / smartLevelUsed / sectionsTotal / sectionsBroken / errors", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/unwrapped: 0/);
		expect(s).toMatch(/headingCounts:/);
		expect(s).toMatch(/smartLevelUsed: null/);
		expect(s).toMatch(/sectionsTotal: 0/);
		expect(s).toMatch(/sectionsBroken: 0/);
		expect(s).toContain("return JSON.stringify(result)");
	});

	it("body style を try/finally で restore する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("} finally {");
		expect(s).toContain("document.body.style.padding = origPadding");
	});
});
