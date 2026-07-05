import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// api.ts の Api type key と index.ts の api Object.freeze() key を level 1 indent（tab 1 個）
// の regex で抽出し、順序込みで一致を検証する。preload API 追加時に両ファイルの更新漏れを
// 本テストが検出する。内側 block（tab 2 個以上）は無視するので inline 実装があっても
// top-level method 名だけが取れる。#209 項目 ①。

const __dirname = dirname(fileURLToPath(import.meta.url));

function extractKeys(source: string, openMarker: string, closeMarker: string): string[] {
	const start = source.indexOf(openMarker);
	if (start === -1) throw new Error(`marker ${JSON.stringify(openMarker)} not found`);
	const end = source.indexOf(closeMarker, start);
	if (end === -1) throw new Error(`marker ${JSON.stringify(closeMarker)} not found`);
	const keys: string[] = [];
	for (const line of source.slice(start, end).split("\n")) {
		const m = line.match(/^\t([A-Za-z_$][A-Za-z0-9_$]*)\s*\??:/);
		if (m) keys.push(m[1]);
	}
	return keys;
}

describe("preload API sync (#209 ①)", () => {
	const typeKeys = extractKeys(
		readFileSync(join(__dirname, "api.ts"), "utf8"),
		"export type Api = Readonly<{",
		"}>;",
	);
	const implKeys = extractKeys(
		readFileSync(join(__dirname, "index.ts"), "utf8"),
		"const api: Api = Object.freeze({",
		"});",
	);

	it("extracts a non-empty key list from both files", () => {
		expect(typeKeys.length).toBeGreaterThan(0);
		expect(implKeys.length).toBeGreaterThan(0);
	});

	it("type keys and impl keys match in order", () => {
		expect(implKeys).toEqual(typeKeys);
	});
});
