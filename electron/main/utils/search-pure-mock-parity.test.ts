// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as searchPure from "./search-pure";

// e2e/helpers/electron-api-mock.ts は addInitScript の script content に
// search-pure.ts の named function を `.toString()` で並べて先頭 inject する経路
// (#209 項目 ③) で動作する。ここでは以下を CI で lock する:
//
//   1. mock が browser scope に inject する予定の名前は search-pure.ts から export される
//   2. 各 pure helper は `.toString()` で `function <name>(...)` 形にシリアライズされる
//      (browser scope に hoist 可能な named function declaration であること)
//   3. mock ソースの PURE_HELPERS 配列 literal に全 entry が含まれる (import 忘れ検出)
//   4. mock ソース内に inline pure 定義が復活していない (再 inline detect)
//
// #278 以前は mock 側に 1:1 inline copy を持ち、search-pure.ts と drift する
// リスクを code review 頼みで抑えていた。#209 項目 ③ 対応で mock inline は消え、
// drift は物理的に不可能になったが、mock 側で誤って inject 経路から離れる変更
// (例: 再 inline) を CI で検出できるようにするのが本 test の目的。

const MOCK_SOURCE_PATH = fileURLToPath(
	new URL("../../../e2e/helpers/electron-api-mock.ts", import.meta.url),
);
const MOCK_SOURCE = readFileSync(MOCK_SOURCE_PATH, "utf8");

// mock が browser scope に inject する必要のある pure helper 群。
// installApiMock 内側の bare identifier 参照から逆算した最小集合。
// 新規に mock が本番 pure helper を利用するなら、ここと mock の PURE_HELPERS 配列に追加する。
const EXPECTED_PURE_HELPERS = [
	"isAsciiOnly",
	"buildLowerToOrigUtf16Map",
	"byteCmp",
	"fuzzyMatch",
	"isEscaped",
	"buildLineStarts",
	"isInRanges",
	"collectInlineCodeRanges",
	"maskRanges",
	"findFencedLines",
] as const;

describe("electron-api-mock <-> search-pure integration (PR #209 ③)", () => {
	it("expected pure helper が search-pure.ts から export されている", () => {
		for (const name of EXPECTED_PURE_HELPERS) {
			expect(searchPure).toHaveProperty(name);
			expect(typeof (searchPure as Record<string, unknown>)[name]).toBe("function");
		}
	});

	it("各 pure helper は `.toString()` で `function <name>(...)` 形にシリアライズされる", () => {
		// tsc / esbuild が named function 宣言を preserve していれば、
		// `${fn.toString()}` を script content に並べただけで browser scope に hoisted な
		// function declaration として置ける (installApiMock 内側から bare 参照可能)。
		// 万一 arrow 化されたり `var fn = function() {...}` に変換されると hoisting が
		// 効かず、mock が browser で ReferenceError を出す。
		for (const name of EXPECTED_PURE_HELPERS) {
			const fn = (searchPure as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
			const src = fn.toString();
			expect(src.startsWith(`function ${name}(`)).toBe(true);
		}
	});

	it("mock ソースの PURE_HELPERS 配列が全 expected entry を含む", () => {
		// mock 側で import しているが PURE_HELPERS 配列に入れ忘れると、browser scope に
		// hoist されず installApiMock 内側の bare 参照が ReferenceError になる。
		// 配列 literal を正規表現で抽出して entry 名の presence を確認する。
		const match = MOCK_SOURCE.match(/const PURE_HELPERS = \[([\s\S]*?)\];/);
		expect(match, "PURE_HELPERS = [...] 配列 literal が見つからない").not.toBeNull();
		const arrayBody = match?.[1] ?? "";
		for (const name of EXPECTED_PURE_HELPERS) {
			// tokenized identifier として現れることを確認 (部分文字列の false positive 回避)。
			const tokenPattern = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
			expect(arrayBody).toMatch(tokenPattern);
		}
	});

	it("mock ソース内に inline pure 定義が復活していない (`const isEscaped =` 等)", () => {
		// #209 項目 ③ 対応で inline copy を全削除した。誤って再定義する PR に対する gate。
		// mock は search-pure.ts の named function を browser scope に inject する経路のみで
		// pure helper を利用する — mock 内 `const <helperName> = (` は import と衝突する。
		for (const name of EXPECTED_PURE_HELPERS) {
			const inlinePattern = new RegExp(`\\bconst ${name} = \\(`);
			expect(
				MOCK_SOURCE,
				`mock 内側で \`const ${name} = (...\` の inline 定義を検出。search-pure.ts の named function を browser scope に inject する経路のみで helper を利用してください。`,
			).not.toMatch(inlinePattern);
		}
	});
});
