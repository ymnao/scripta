import { describe, expect, it } from "vitest";
import { buildSectionBreakScript } from "./page-break-script";

describe("buildSectionBreakScript (#93)", () => {
	it("IIFE 形式で返す", () => {
		const s = buildSectionBreakScript();
		expect(s.startsWith("(function() {")).toBe(true);
		expect(s.trimEnd().endsWith("})();")).toBe(true);
	});

	it("body 直下 h1〜h6 を 1-pass で集計する", () => {
		const s = buildSectionBreakScript();
		// 6 連続の querySelectorAll ではなく、children を 1 度走査する形であること
		expect(s).toContain("var bodyChildren = document.body.children;");
		expect(s).not.toMatch(/for \(var lvl = 1; lvl <= 6/);
	});

	it("smart-level meta が無ければ即 return (smart=false / level=none で確実に no-op)", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/if \(!levelMeta\) return JSON\.stringify\(result\)/);
	});

	it("smart-level 解決: meta 優先、不在時は requested より浅いレベルにのみ fallback", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("'meta[name=\"scripta-pdf-smart-level\"]'");
		// requested-1 から 1 まで降順で fallback ループ
		expect(s).toMatch(/for \(var fb = requestedLevel - 1; fb >= 1; fb--\)/);
		// 旧コード ("deeper fallback") の優先順表 (h2 > h3 > h1 > h4) は無効値時のみ
		expect(s).toMatch(/hc\.h2 >= 2/);
	});

	it("break-inside: avoid 要素 (LI 含む) が現ページに収まらないなら virtualY を次ページにジャンプ", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("isAvoidBreakInside");
		expect(s).toMatch(/'P' \|\| t === 'PRE'/);
		expect(s).toContain("'LI'");
		expect(s).toContain("mermaid-diagram");
		expect(s).toMatch(/h > remainingA/);
	});

	it("body 直下の UL/OL を展開して LI を children に並べる (LI 単位の break-inside avoid 反映のため)", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/c\.tagName === 'UL' \|\| c\.tagName === 'OL'/);
		expect(s).toMatch(/lis\[li\]\.tagName === 'LI'/);
	});

	it("fallback で smart level が下がった場合、forceLevel を smartLevel-1 にクランプ", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/if \(forceLevel >= smartLevel\) forceLevel = smartLevel - 1/);
	});

	it("force-level meta を読み、該当見出しで virtualY を次ページ頭へジャンプする", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("'meta[name=\"scripta-pdf-force-level\"]'");
		expect(s).toMatch(/fhLvl <= forceLevel/);
		expect(s).toMatch(/pageHeight - inPageF/);
	});

	it("criterion を meta tag (scripta-pdf-criterion) から読む", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("'meta[name=\"scripta-pdf-criterion\"]'");
		expect(s).toContain("'section'");
		expect(s).toContain("'compact'");
	});

	it("ページ高さルーラーは (257 / zoom) mm で zoom 補正を入れる", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("(257 / zoom)");
	});

	it("印刷幅 170mm へ body を一時揃える", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("(170 / zoom) + 'mm'");
	});

	it("safety buffer 5% で screen ⇔ print の layout drift を吸収する", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("pageHeight * 0.05");
	});

	it("compact criterion は heading + 直後ブロックのみで needed height を計算", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("criterion === 'compact'");
		expect(s).toMatch(/criterion === 'compact'[\s\S]{0,400}heights\[i \+ 1\]/);
	});

	it("section criterion は次の同位以下見出し or HR pagebreak まで集計", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("nxLvl <= smartLevel");
		expect(s).toContain("'pdf-pagebreak'");
	});

	it("section が現ページに収まらない時、見出し自身に inline break-before を注入", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("item.style.breakBefore = 'page'");
		expect(s).toContain("item.style.pageBreakBefore = 'always'");
		expect(s).toMatch(/neededH \+ safetyBuffer/);
	});

	it("診断 JSON: headingCounts / smartLevelUsed / criterion / sectionsTotal / sectionsBroken / errors", () => {
		const s = buildSectionBreakScript();
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
