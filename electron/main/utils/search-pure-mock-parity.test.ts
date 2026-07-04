// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as searchPure from "./search-pure";

// e2e/helpers/electron-api-mock.ts は addInitScript の script content に
// search-pure.ts の named function を `.toString()` で並べて先頭 inject する経路
// (#209 項目 ③) で動作する。ここでは以下を CI で lock する:
//
//   1. search-pure.ts の function export はすべて `function <name>(...)` 形に
//      シリアライズされる (browser scope に hoist 可能な named function declaration)
//   2. mock ソース内に inline pure 定義が復活していない (再 inline detect)
//
// PURE_HELPERS 配列は mock 側で `Object.values(searchPure).filter(fn)` から派生する
// (手動 list なし) ため、「配列に入れ忘れ」ケースはそもそも起きず regex 抽出テストは
// 不要になった。runtime 挙動の end-to-end 検証は e2e (renderer-only) が担当する。

const MOCK_SOURCE_PATH = fileURLToPath(
	new URL("../../../e2e/helpers/electron-api-mock.ts", import.meta.url),
);
const MOCK_SOURCE = readFileSync(MOCK_SOURCE_PATH, "utf8");

// map で呼ぶのは fn.toString() だけなので narrow は最小限に。
const SEARCH_PURE_FUNCTIONS = Object.entries(searchPure).filter(
	([, fn]) => typeof fn === "function",
) as Array<[string, { toString(): string }]>;

describe("electron-api-mock <-> search-pure integration (PR #209 ③)", () => {
	it("search-pure.ts の function export はすべて `function <name>(...)` 形にシリアライズされる", () => {
		// tsc / esbuild が named function 宣言を preserve していれば、
		// `${fn.toString()}` を script content に並べただけで browser scope に hoisted な
		// function declaration として置ける (installApiMock 内側から bare 参照可能)。
		// 万一 arrow 化されたり `var fn = function() {...}` に変換されると hoisting が
		// 効かず、mock が browser で ReferenceError を出す。search-pure.ts の doc も
		// この形式で書くことを contract として明記している。
		expect(SEARCH_PURE_FUNCTIONS.length).toBeGreaterThan(0);
		for (const [name, fn] of SEARCH_PURE_FUNCTIONS) {
			const src = fn.toString();
			expect(src.startsWith(`function ${name}(`), `${name}: ${src.slice(0, 40)}`).toBe(true);
		}
	});

	it("mock ソース内に inline pure 定義が復活していない (`const isEscaped =` 等)", () => {
		// #209 項目 ③ 対応で inline copy を全削除した。誤って再定義する PR に対する gate。
		// mock は search-pure.ts の named function を browser scope に inject する経路のみで
		// pure helper を利用する — mock 内 `const <helperName> = (` は import と衝突する。
		for (const [name] of SEARCH_PURE_FUNCTIONS) {
			const inlinePattern = new RegExp(`\\bconst ${name} = \\(`);
			expect(
				MOCK_SOURCE,
				`mock 内側で \`const ${name} = (...\` の inline 定義を検出。search-pure.ts の named function を browser scope に inject する経路のみで helper を利用してください。`,
			).not.toMatch(inlinePattern);
		}
	});
});
