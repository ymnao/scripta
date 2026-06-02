import { describe, expect, it } from "vitest";
import { buildSectionBreakScript } from "./page-break-script";

// behavior-contract のみ assert する (実装詳細の文字列マッチに依存しない最小セット)。
// e2e が実 Electron で script の戻り値を直接 assert するのでそちらが本筋の safety net。
describe("buildSectionBreakScript (#93)", () => {
	it("IIFE 形式で返す", () => {
		const s = buildSectionBreakScript();
		expect(s.startsWith("(function() {")).toBe(true);
		expect(s.trimEnd().endsWith("})();")).toBe(true);
	});

	it("smart-level / criterion の meta tag 名を読む (renderer との契約)", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain('meta[name="scripta-pdf-smart-level"]');
		expect(s).toContain('meta[name="scripta-pdf-criterion"]');
	});

	it("smart-level meta が無ければ即 return (smart=false / 対象見出し不足で no-op)", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/if \(!levelMeta\) return JSON\.stringify\(result\)/);
	});

	it("見出しに inline `style.breakBefore = 'page'` を注入する経路を持つ", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("item.style.breakBefore = 'page'");
		expect(s).toContain("item.style.pageBreakBefore = 'always'");
	});

	it("診断 JSON: smartLevelUsed / criterion / sectionsTotal / sectionsBroken / errors を返す", () => {
		const s = buildSectionBreakScript();
		expect(s).toMatch(/smartLevelUsed: null/);
		expect(s).toMatch(/sectionsTotal: 0/);
		expect(s).toMatch(/sectionsBroken: 0/);
		expect(s).toMatch(/errors: \[\]/);
		expect(s).toContain("return JSON.stringify(result)");
	});

	it("body style を try/finally で restore する (例外でも壊れない)", () => {
		const s = buildSectionBreakScript();
		expect(s).toContain("} finally {");
		expect(s).toContain("document.body.style.padding = origPadding");
	});
});
