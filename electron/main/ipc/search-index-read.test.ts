// @vitest-environment node
//
// #412: index 取り込みに繋がる read が「末端 symlink を拒否する fd read」であることを
// **wiring レベルで** pin する。
//
// なぜ wiring を直接 pin するか: `IdleFillDeps.readFile` / dark assert の deps は型が
// `(p: string) => Promise<string>` でしかなく、plain `fsp.readFile` を注入しても型は通る。
// 契約は doc コメントにしか載らないため、production の wiring を revert する退行は
// deps を fake で差し替える既存 test では検出できない。
//
// **検出できる範囲は helper 単位まで**: buildIdleFillDeps / readForReindex が plain read に
// 戻る退行は殺せるが、**呼び出し側が helper を経由しなくなる**退行 (searchFilesImpl が
// inline literal deps に戻す / runDarkAssert が inline lambda に戻す) は green のまま通る。
// そちらは call site 側のコメントで契約を明示して防いでいる (search.ts の kickIdleFill /
// dark assert deps)。完全に塞ぐには search-cache の state 構築が要るため、ここでは扱わない。
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { createCanonicalTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import { __testing } from "./search";
import type { InvertedIndexHandle } from "./search-cache";

const { buildIdleFillDeps, readForReindex } = __testing;

// buildIdleFillDeps は index handle を素通しするだけなので、read 経路の pin には
// 最小の stub で足りる。
const stubIndex = {
	indexFile: () => {},
	currentEpochOf: () => 0,
	isIndexedAndValid: () => false,
	getCandidates: () => ({ kind: "fallback" }) as const,
	verify: () => {},
	collectViolations: () => null,
	get isDisabled(): boolean {
		return false;
	},
} satisfies InvertedIndexHandle;

describe.skipIf(process.platform === "win32")("index 取り込み read の wiring (#412)", () => {
	let ws: TempWorkspace;
	let outside: TempWorkspace;
	/** 末端が workspace 外を指す symlink になった file (= 認可後に swap された終状態)。 */
	let swapped = "";
	/** 通常の実体 file (退行検知用)。 */
	let normal = "";

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-index-read-");
		outside = await createCanonicalTempWorkspace("scripta-index-read-out-");
		const secret = join(outside.dir, "secret.txt");
		await fsp.writeFile(secret, "SECRETWORD", "utf8");
		swapped = join(ws.dir, "swapped.md");
		await fsp.symlink(secret, swapped);
		normal = join(ws.dir, "normal.md");
		await fsp.writeFile(normal, "normal body", "utf8");
	});

	afterEach(async () => {
		await ws.cleanup();
		await outside.cleanup();
	});

	it("idle fill の readFile は末端 symlink を拒否する", async () => {
		const deps = buildIdleFillDeps(ws.dir, stubIndex);

		// 通常 file は従来どおり読める。
		await expect(deps.readFile(normal)).resolves.toBe("normal body");
		// 末端が symlink の file は reject する (呼び手の skipUntilEpochChange 経路に倒れる)。
		await expect(deps.readFile(swapped)).rejects.toThrow();
	});

	it("dark assert の再 index read は末端 symlink を拒否して null を返す", async () => {
		// 読めない file は null = 「再検証できない」に倒す既存契約 (#405) は維持する。
		expect(await readForReindex(normal)).toBe("normal body");
		expect(await readForReindex(swapped)).toBeNull();
	});
});
