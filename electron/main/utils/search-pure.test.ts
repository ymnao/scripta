// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildLowerToOrigUtf16Map, isAsciiOnly } from "./search-pure";

describe("isAsciiOnly", () => {
	it("returns true for ASCII strings", () => {
		expect(isAsciiOnly("hello")).toBe(true);
		expect(isAsciiOnly("")).toBe(true);
		expect(isAsciiOnly("ABC 123 !@#")).toBe(true);
	});

	it("returns false for non-ASCII strings", () => {
		expect(isAsciiOnly("あ")).toBe(false);
		expect(isAsciiOnly("İ")).toBe(false);
		expect(isAsciiOnly("😀")).toBe(false);
		expect(isAsciiOnly("hello 日本")).toBe(false);
	});

	it("treats DEL (0x7F) as ASCII boundary", () => {
		// 旧実装と同様 charCodeAt > 127 のみ false。0x7F (127) は ASCII 範囲。
		expect(isAsciiOnly("")).toBe(true);
		expect(isAsciiOnly("")).toBe(false);
	});
});

describe("buildLowerToOrigUtf16Map", () => {
	it("returns null for ASCII-only strings", () => {
		expect(buildLowerToOrigUtf16Map("hello")).toBeNull();
		expect(buildLowerToOrigUtf16Map("")).toBeNull();
	});

	it("maps lowercase positions back when toLowerCase changes length (Turkish İ)", () => {
		// "İ" (U+0130, 1 UTF-16 unit) → "i̇" (2 UTF-16 units)
		// "İhello" (length 6) → "i̇hello" (length 7)
		const map = buildLowerToOrigUtf16Map("İhello");
		expect(map).not.toBeNull();
		// lower index 0 ('i') と 1 ('̇') は orig index 0 (İ) を指す
		expect(map?.[0]).toBe(0);
		expect(map?.[1]).toBe(0);
		// lower index 2 ('h') 以降は orig index が 1 ずつ増える
		expect(map?.[2]).toBe(1);
		expect(map?.[3]).toBe(2);
		expect(map?.[4]).toBe(3);
		expect(map?.[5]).toBe(4);
		expect(map?.[6]).toBe(5);
		// sentinel
		expect(map?.[7]).toBe(6);
		expect(map).toHaveLength(8);
	});

	it("returns identity-like map for Japanese (no length change)", () => {
		// 「あいう」は各 char 1 UTF-16 unit、toLowerCase でも変化しない
		const map = buildLowerToOrigUtf16Map("あいう");
		expect(map).not.toBeNull();
		expect(map).toEqual([0, 1, 2, 3]);
	});

	it("handles surrogate pairs (emoji is 2 UTF-16 units)", () => {
		// "😀a" → length 3 (😀=2 + a=1)。toLowerCase は 😀 の長さを変えないし a は ASCII で同じ。
		const map = buildLowerToOrigUtf16Map("😀a");
		expect(map).not.toBeNull();
		// 😀 の 2 unit はどちらも orig 0 を指す（自分自身の開始位置）
		expect(map?.[0]).toBe(0);
		expect(map?.[1]).toBe(0);
		// a は orig 2
		expect(map?.[2]).toBe(2);
		// sentinel
		expect(map?.[3]).toBe(3);
	});

	it("sentinel at end equals text.length", () => {
		const text = "İhello";
		const map = buildLowerToOrigUtf16Map(text);
		expect(map?.[map.length - 1]).toBe(text.length);
	});

	it("handles İ alone (boundary)", () => {
		const map = buildLowerToOrigUtf16Map("İ");
		expect(map).toEqual([0, 0, 1]);
	});
});
