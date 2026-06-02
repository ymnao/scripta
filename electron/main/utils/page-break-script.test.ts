import { describe, expect, it } from "vitest";
import { buildSectionBreakScript } from "./page-break-script";

describe("buildSectionBreakScript (#93 v4 table-row hack)", () => {
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

	it("smartLevel 自動検出: h2 > h3 > h1 > h4 の優先順", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/hc\.h2 >= 2/);
		expect(s).toMatch(/hc\.h3 >= 2/);
		expect(s).toMatch(/hc\.h1 >= 2/);
		expect(s).toMatch(/hc\.h4 >= 2/);
	});

	it("既存 .pdf-section-keep の break-inside を auto !important で override する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("break-inside: auto !important");
		expect(s).toContain("page-break-inside: auto !important");
	});

	it("table 装飾 CSS を inject する (width 100%, border-collapse, padding 0)", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("width: 100%");
		expect(s).toContain("border-collapse: collapse");
		expect(s).toContain("padding: 0");
	});

	it("table > tbody > tr に break-inside: avoid を当てて atomic 化", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/table\.pdf-section-keep > tbody > tr.*?break-inside: avoid/s);
		expect(s).toMatch(/page-break-inside: avoid/);
	});

	it("既存 <section> wrap を <table> 構造に変換する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("sec.tagName === 'TABLE'");
		expect(s).toContain("table.className = 'pdf-section-keep'");
		expect(s).toContain("document.createElement('tbody')");
		expect(s).toContain("document.createElement('tr')");
		expect(s).toContain("document.createElement('td')");
	});

	it("renderer 未 wrap でも smartLevel の heading を table 化する経路がある", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("wrapAsTable");
	});

	it("診断 JSON: rendererWrapped / headingCounts / smartLevelUsed / count / converted / errors", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/rendererWrapped: false/);
		expect(s).toMatch(/headingCounts:/);
		expect(s).toMatch(/smartLevelUsed: null/);
		expect(s).toMatch(/converted: 0/);
		expect(s).toContain("return JSON.stringify(result)");
	});

	it("table.pdf-section-keep が DOM に存在するか最後に count する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("document.querySelectorAll('table.pdf-section-keep').length");
	});
});
