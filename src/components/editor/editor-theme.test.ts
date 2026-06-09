import { describe, expect, it } from "vitest";
import { parseHorizontalPadding } from "./editor-theme";

describe("parseHorizontalPadding", () => {
	it("1 値 (全方向同値) は left/right ともにその値", () => {
		expect(parseHorizontalPadding("16px")).toEqual({ left: 16, right: 16 });
	});

	it("2 値 (上下/左右) は 2 番目が left/right 両方", () => {
		expect(parseHorizontalPadding("8px 48px")).toEqual({ left: 48, right: 48 });
		expect(parseHorizontalPadding("4px 12px")).toEqual({ left: 12, right: 12 });
	});

	it("3 値 (上/左右/下) は 2 番目が left/right 両方", () => {
		expect(parseHorizontalPadding("8px 48px 16px")).toEqual({ left: 48, right: 48 });
	});

	it("4 値 (上/右/下/左) は left=4 番目, right=2 番目", () => {
		expect(parseHorizontalPadding("8px 12px 16px 24px")).toEqual({ left: 24, right: 12 });
	});

	it("複数スペース・前後空白を許容する", () => {
		expect(parseHorizontalPadding("  8px   48px  ")).toEqual({ left: 48, right: 48 });
	});

	it("単位は parseInt ベースで剥がす", () => {
		expect(parseHorizontalPadding("8 48")).toEqual({ left: 48, right: 48 });
	});

	it("空文字・不正値は 0 にフォールバック", () => {
		expect(parseHorizontalPadding("")).toEqual({ left: 0, right: 0 });
		expect(parseHorizontalPadding("auto")).toEqual({ left: 0, right: 0 });
	});
});
