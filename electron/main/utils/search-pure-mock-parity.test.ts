// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as searchPure from "./search-pure";

// e2e/helpers/electron-api-mock.ts は addInitScript の script content に
// search-pure.ts の named function を `.toString()` で並べて先頭 inject する経路
// で動作する。ここでは以下を CI で lock する:
//
//   1. search-pure.ts の function export はすべて `function <name>(...)` 形に
//      シリアライズされる (browser scope に hoist 可能な named function declaration)
//   2. mock ソース内に inline pure 定義が復活していない (再 inline detect)
//      — `const|let|var|function` いずれの宣言形も検出する
//   3. mock の named import と PURE_HELPERS 配列が同じ identifier 列を持つ
//      (import に載せたが PURE_HELPERS 忘れ / その逆による runtime ReferenceError を防ぐ)

const MOCK_SOURCE_PATH = fileURLToPath(
	new URL("../../../e2e/helpers/electron-api-mock.ts", import.meta.url),
);
const MOCK_SOURCE = readFileSync(MOCK_SOURCE_PATH, "utf8");

// map で呼ぶのは fn.toString() だけなので narrow は最小限に。
const SEARCH_PURE_FUNCTIONS = Object.entries(searchPure).filter(
	([, fn]) => typeof fn === "function",
) as Array<[string, { toString(): string }]>;

/**
 * mock ソースから `const { a, b, c } = searchPure;` の destructure identifier 列を抽出する。
 * 経路: Playwright bundled babel の CommonJS transform が named import の bare 参照を
 * `_searchPure.foo` に rewrite するため、mock は `import * as searchPure` + destructure で
 * local const 化して bare 参照を preserve する必要がある (詳細は mock file の comment 参照)。
 */
function extractSearchPureDestructure(source: string): string[] {
	const destructureMatch = source.match(/const\s*\{([\s\S]*?)\}\s*=\s*searchPure\s*;/);
	if (!destructureMatch) return [];
	return destructureMatch[1]
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !s.startsWith("//"));
}

/**
 * mock ソースから `const PURE_HELPERS = [ a, b, c ]` の identifier 列を抽出する。
 */
function extractPureHelpersArray(source: string): string[] {
	const arrMatch = source.match(/const PURE_HELPERS = \[([\s\S]*?)\];/);
	if (!arrMatch) return [];
	return arrMatch[1]
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !s.startsWith("//"));
}

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

	it("mock ソース内に inline pure 定義が復活していない (`const|let|var|function <name>` 全形)", () => {
		// inline copy を復活させる PR に対する gate。宣言形は 4 種類あり得るので全部拾う:
		//   const isEscaped = (...) => {...}
		//   let isEscaped = (...) => {...}
		//   var isEscaped = (...) => {...}
		//   function isEscaped(...) {...}
		// mock は search-pure.ts の named function を browser scope に inject する経路のみで
		// pure helper を利用する — inline 再定義はいずれも import と衝突するか browser 側で
		// 意図せず shadowing を招く。
		for (const [name] of SEARCH_PURE_FUNCTIONS) {
			const declPattern = new RegExp(
				`\\b(const|let|var)\\s+${name}\\s*=|\\bfunction\\s+${name}\\s*\\(`,
			);
			expect(
				MOCK_SOURCE,
				`mock 内側で ${name} の inline 定義を検出。search-pure.ts の named function を browser scope に inject する経路のみで helper を利用してください。`,
			).not.toMatch(declPattern);
		}
	});

	it("mock の searchPure destructure と PURE_HELPERS 配列が同じ identifier 列を持つ", () => {
		// 一方に足したがもう一方に足し忘れると:
		//   - destructure に有り / PURE_HELPERS に無し → browser 側で inject されず ReferenceError
		//   - PURE_HELPERS に有り / destructure に無し → tsc が unresolved identifier で fail (safer)
		// 前者は runtime failure なので静的 gate で catch する。
		const destructured = extractSearchPureDestructure(MOCK_SOURCE).sort();
		const pureHelpers = extractPureHelpersArray(MOCK_SOURCE).sort();
		expect(destructured.length).toBeGreaterThan(0);
		expect(pureHelpers.length).toBeGreaterThan(0);
		expect(pureHelpers).toEqual(destructured);
	});
});
