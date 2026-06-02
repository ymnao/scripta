import { describe, expect, it } from "vitest";
import { buildPageBreakScript } from "./page-break-script";

describe("buildPageBreakScript", () => {
	it("emits correct maxLevel for level=1", () => {
		const script = buildPageBreakScript({ level: 1, criterion: "compact" });
		expect(script).toContain("var maxLevel = 1;");
	});

	it("emits correct maxLevel for level=2", () => {
		const script = buildPageBreakScript({ level: 2, criterion: "compact" });
		expect(script).toContain("var maxLevel = 2;");
	});

	it("emits correct maxLevel for level=3", () => {
		const script = buildPageBreakScript({ level: 3, criterion: "compact" });
		expect(script).toContain("var maxLevel = 3;");
	});

	it("sets forceLevel = level-1 for level>1 (forceUpperBreak は内部仕様で常時 ON)", () => {
		const s2 = buildPageBreakScript({ level: 2, criterion: "compact" });
		const s3 = buildPageBreakScript({ level: 3, criterion: "compact" });
		expect(s2).toContain("var forceLevel = 1;");
		expect(s3).toContain("var forceLevel = 2;");
	});

	it("sets forceLevel = 0 for level=1 (上位が無い)", () => {
		const script = buildPageBreakScript({ level: 1, criterion: "compact" });
		expect(script).toContain("var forceLevel = 0;");
	});

	it("embeds criterion as JSON string (compact)", () => {
		const script = buildPageBreakScript({ level: 2, criterion: "compact" });
		expect(script).toContain('var criterion = "compact";');
	});

	it("embeds criterion as JSON string (section)", () => {
		const script = buildPageBreakScript({ level: 2, criterion: "section" });
		expect(script).toContain('var criterion = "section";');
	});

	it("uses safetyBuffer = 0 (safePageHeight === pageHeight)", () => {
		const script = buildPageBreakScript({ level: 2, criterion: "compact" });
		// 旧実装の `pageHeight - safetyBuffer * 3` パターンが残っていないこと
		expect(script).not.toMatch(/safetyBuffer\s*\*\s*3/);
		expect(script).toContain("var safePageHeight = pageHeight;");
	});

	it("does NOT contain firstTargetHeading (削除済み, CSS 仕様で守られる)", () => {
		const script = buildPageBreakScript({ level: 2, criterion: "compact" });
		expect(script).not.toContain("firstTargetHeading");
	});

	it("handles pdf-pagebreak marker via classList check", () => {
		const script = buildPageBreakScript({ level: 2, criterion: "compact" });
		expect(script).toContain("'pdf-pagebreak'");
		expect(script).toMatch(/classList.*pdf-pagebreak/);
	});

	it("returns an IIFE (self-invoking function expression)", () => {
		const script = buildPageBreakScript({ level: 2, criterion: "compact" });
		expect(script.startsWith("(function() {")).toBe(true);
		expect(script.trimEnd().endsWith("})();")).toBe(true);
	});

	it("section criterion uses kLevel <= maxLevel as section terminator", () => {
		const script = buildPageBreakScript({ level: 3, criterion: "section" });
		// section 用ループの早期 break 条件
		expect(script).toContain("kLevel <= maxLevel");
	});
});
