// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	buildLineStarts,
	buildLowerToOrigUtf16Map,
	byteCmp,
	collectInlineCodeRanges,
	findFencedLines,
	fuzzyMatch,
	isAsciiOnly,
	isEscaped,
	isInRanges,
	maskRanges,
} from "./search-pure";

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

describe("byteCmp", () => {
	it("returns negative when a < b", () => {
		expect(byteCmp("apple", "banana")).toBe(-1);
	});

	it("returns positive when a > b", () => {
		expect(byteCmp("banana", "apple")).toBe(1);
	});

	it("returns 0 for equal strings", () => {
		expect(byteCmp("same", "same")).toBe(0);
	});

	it("uses code-unit order (not locale)", () => {
		// UTF-16 code unit 順で "Z" (0x5A) < "a" (0x61)。locale ソートだと "a" < "Z" になり得る。
		expect(byteCmp("Z", "a")).toBe(-1);
	});

	it("is usable as Array.prototype.sort comparator", () => {
		const arr = ["banana", "apple", "cherry"];
		arr.sort(byteCmp);
		expect(arr).toEqual(["apple", "banana", "cherry"]);
	});
});

describe("fuzzyMatch", () => {
	it("matches when query chars appear in order", () => {
		expect(fuzzyMatch("hw", "hello-world.md")).toBe(true);
	});

	it("returns true for empty query", () => {
		expect(fuzzyMatch("", "anything")).toBe(true);
	});

	it("returns false when chars missing", () => {
		expect(fuzzyMatch("xyz", "hello")).toBe(false);
	});

	it("is case insensitive", () => {
		expect(fuzzyMatch("HW", "hello-world.md")).toBe(true);
		expect(fuzzyMatch("hw", "Hello-World.md")).toBe(true);
	});
});

describe("isEscaped", () => {
	it("returns false at start of string", () => {
		expect(isEscaped("[[target]]", 0)).toBe(false);
	});

	it("returns true after a single backslash", () => {
		expect(isEscaped("\\[[target]]", 1)).toBe(true);
	});

	it("returns false after two backslashes (even count)", () => {
		expect(isEscaped("\\\\[[target]]", 2)).toBe(false);
	});

	it("returns true after three backslashes (odd count)", () => {
		expect(isEscaped("\\\\\\[[target]]", 3)).toBe(true);
	});

	it("returns false when preceding char is not backslash", () => {
		expect(isEscaped("hello [[target]]", 6)).toBe(false);
	});
});

describe("buildLineStarts", () => {
	it("returns start offsets for each line with LF separator", () => {
		const text = "abc\ndef\nghi";
		const lines = text.split(/\r?\n/);
		expect(buildLineStarts(text, lines)).toEqual([0, 4, 8]);
	});

	it("handles CRLF separator", () => {
		const text = "abc\r\ndef\r\nghi";
		const lines = text.split(/\r?\n/);
		expect(buildLineStarts(text, lines)).toEqual([0, 5, 10]);
	});

	it("handles empty lines", () => {
		const text = "a\n\nb";
		const lines = text.split(/\r?\n/);
		expect(buildLineStarts(text, lines)).toEqual([0, 2, 3]);
	});

	it("handles single line without newline", () => {
		const text = "hello";
		const lines = text.split(/\r?\n/);
		expect(buildLineStarts(text, lines)).toEqual([0]);
	});
});

describe("isInRanges", () => {
	const ranges = [
		{ from: 0, to: 5 },
		{ from: 10, to: 15 },
	];

	it("returns true when pos is inside a range", () => {
		expect(isInRanges(3, ranges)).toBe(true);
		expect(isInRanges(10, ranges)).toBe(true);
	});

	it("returns false when pos is outside all ranges", () => {
		expect(isInRanges(6, ranges)).toBe(false);
		expect(isInRanges(20, ranges)).toBe(false);
	});

	it("uses half-open [from, to) semantics: `to` itself is NOT inside", () => {
		expect(isInRanges(5, ranges)).toBe(false);
		expect(isInRanges(15, ranges)).toBe(false);
	});

	it("returns false for empty ranges", () => {
		expect(isInRanges(0, [])).toBe(false);
	});
});

describe("collectInlineCodeRanges", () => {
	it("returns [] for text without backticks", () => {
		expect(collectInlineCodeRanges("plain text")).toEqual([]);
	});

	it("detects single backtick code span", () => {
		// "a `x` b" — code span at offset 2-5 (includes both delimiters)
		expect(collectInlineCodeRanges("a `x` b")).toEqual([{ from: 2, to: 5 }]);
	});

	it("detects double backtick code span", () => {
		// "``[[x]]``" — code span at 0-9 with 2-backtick delimiters
		expect(collectInlineCodeRanges("``[[x]]``")).toEqual([{ from: 0, to: 9 }]);
	});

	it("skips run whose first char is escaped (whole run, not just i++)", () => {
		// "\\`` [[t]] `" — the `\\`` run is fully escaped (2-char run starting escaped),
		// so no code span opens. The trailing lone `` ` `` also has no close → literal.
		expect(collectInlineCodeRanges("\\`` [[t]] `")).toEqual([]);
	});

	it("treats close side without escape check (backslash before close is literal)", () => {
		// "`foo \\` [[t]] bar`" — the `\\`` closes the span at offset 6 (close side ignores escape).
		expect(collectInlineCodeRanges("`foo \\` [[t]] bar`")).toEqual([{ from: 0, to: 7 }]);
	});

	it("returns nothing when open has no matching close", () => {
		expect(collectInlineCodeRanges("lone ` no close")).toEqual([]);
	});

	it("crosses newlines (CommonMark multi-line code span)", () => {
		// "in `start\n[[t]]\nend`" — code span spans lines, from 3 to 20.
		const s = "in `start\n[[t]]\nend`";
		expect(collectInlineCodeRanges(s)).toEqual([{ from: 3, to: 20 }]);
	});
});

describe("maskRanges", () => {
	it("replaces masked line ranges with spaces preserving length", () => {
		const text = "abc\ndef\nghi";
		const lines = text.split("\n");
		const lineStarts = [0, 4, 8];
		const mask = [false, true, false];
		// 「def」の 3 文字（offset 4-6）が space に置換される
		expect(maskRanges(text, lines, lineStarts, mask)).toBe("abc\n   \nghi");
	});

	it("returns identical text when nothing masked", () => {
		const text = "abc\ndef";
		const lines = text.split("\n");
		const lineStarts = [0, 4];
		expect(maskRanges(text, lines, lineStarts, [false, false])).toBe(text);
	});
});

describe("findFencedLines", () => {
	it("detects backtick fence", () => {
		expect(findFencedLines(["```", "code", "```"])).toEqual([true, true, true]);
	});

	it("detects tilde fence", () => {
		expect(findFencedLines(["~~~", "code", "~~~"])).toEqual([true, true, true]);
	});

	it("~~~ opener is not closed by ```", () => {
		// tilde で開いたら backtick では閉じない → 全行 fenced
		expect(findFencedLines(["~~~", "```", "still", "~~~"])).toEqual([true, true, true, true]);
	});

	it("length-4 opener is not closed by length-3 marker", () => {
		// ```` (4) opener → ``` (3) では閉じない
		expect(findFencedLines(["````", "code", "```", "still", "````"])).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
	});

	it("closer with trailing non-whitespace is not a closer", () => {
		expect(findFencedLines(["```", "code", "``` info", "still", "```"])).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
	});

	it("backtick fence opener with backtick in info string is not a fence", () => {
		expect(findFencedLines(["``` info `x`", "paragraph"])).toEqual([false, false]);
	});

	it("tilde fence allows backtick in info string", () => {
		// ~~~ の info string には backtick 制約はない
		expect(findFencedLines(["~~~ info `x`", "code", "~~~"])).toEqual([true, true, true]);
	});

	it("4-space-indented ``` in continuation is not a fence marker", () => {
		expect(findFencedLines(["paragraph", "    ```", "[[t]]"])).toEqual([false, false, false]);
	});
});
