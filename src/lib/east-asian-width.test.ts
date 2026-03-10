import { describe, expect, it } from "vitest";
import { getStringWidth, isEastAsianFullwidth } from "./east-asian-width";

function cp(char: string): number {
	const code = char.codePointAt(0);
	if (code === undefined) throw new Error(`Invalid character: ${char}`);
	return code;
}

describe("isEastAsianFullwidth", () => {
	it("CJK漢字をfullwidthと判定する", () => {
		expect(isEastAsianFullwidth(cp("漢"))).toBe(true);
		expect(isEastAsianFullwidth(cp("字"))).toBe(true);
	});

	it("ひらがな・カタカナをfullwidthと判定する", () => {
		expect(isEastAsianFullwidth(cp("あ"))).toBe(true);
		expect(isEastAsianFullwidth(cp("ア"))).toBe(true);
	});

	it("ハングルをfullwidthと判定する", () => {
		expect(isEastAsianFullwidth(cp("한"))).toBe(true);
	});

	it("ASCII文字をfullwidthと判定しない", () => {
		expect(isEastAsianFullwidth(cp("A"))).toBe(false);
		expect(isEastAsianFullwidth(cp("1"))).toBe(false);
		expect(isEastAsianFullwidth(cp(" "))).toBe(false);
	});
});

describe("getStringWidth", () => {
	it("ASCII文字列の幅を計算する", () => {
		expect(getStringWidth("hello")).toBe(5);
	});

	it("全角文字列の幅を計算する", () => {
		expect(getStringWidth("漢字")).toBe(4);
	});

	it("混合文字列の幅を計算する", () => {
		expect(getStringWidth("Hello漢字")).toBe(9);
	});

	it("空文字列の幅は0", () => {
		expect(getStringWidth("")).toBe(0);
	});
});
