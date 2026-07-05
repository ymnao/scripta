import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// api.ts の Api type 内 property key、および index.ts の api Object.freeze() 内 method key を
// 抽出して、両ファイルの key list（順序込み）が完全一致することを検証する。preload API を
// 新規追加する際は必ず両ファイルを更新しないと本テストが fail する。
//
// 追加依存（ts-morph 等）を避けるため level 1 indent（tab 1 個）にある identifier を正規表現で
// 抽出している。内側 block（tab 2 個以上）は無視するので onWindowCloseRequested のような
// multi-line 実装があっても top-level method 名だけが取れる。
//
// #209 項目 ① の実装。

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPreloadFile(name: string): string {
	return readFileSync(join(__dirname, name), "utf8");
}

function extractApiTypeKeys(source: string): string[] {
	const start = source.indexOf("export type Api = Readonly<{");
	if (start === -1) throw new Error("Api type declaration not found in api.ts");
	const end = source.indexOf("}>;", start);
	if (end === -1) throw new Error("Api type closing not found in api.ts");
	return extractLevel1Keys(source.slice(start, end));
}

function extractApiObjectKeys(source: string): string[] {
	const start = source.indexOf("const api: Api = Object.freeze({");
	if (start === -1) throw new Error("api object declaration not found in index.ts");
	const end = source.indexOf("});", start);
	if (end === -1) throw new Error("api object closing not found in index.ts");
	return extractLevel1Keys(source.slice(start, end));
}

function extractLevel1Keys(block: string): string[] {
	const keys: string[] = [];
	for (const line of block.split("\n")) {
		const m = line.match(/^\t([A-Za-z_$][A-Za-z0-9_$]*)\s*\??:/);
		if (m) keys.push(m[1]);
	}
	return keys;
}

describe("preload API sync (#209 ①)", () => {
	const typeKeys = extractApiTypeKeys(readPreloadFile("api.ts"));
	const implKeys = extractApiObjectKeys(readPreloadFile("index.ts"));

	it("extracts a non-empty key list from both files", () => {
		expect(typeKeys.length).toBeGreaterThan(0);
		expect(implKeys.length).toBeGreaterThan(0);
	});

	it("type key count equals impl key count", () => {
		expect(implKeys.length).toBe(typeKeys.length);
	});

	it("type keys and impl keys match in order", () => {
		expect(implKeys).toEqual(typeKeys);
	});
});
