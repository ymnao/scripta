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

import { makeFakeIndex } from "../test-utils/search-fakes";
import { createCanonicalTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import { __testing } from "./search";
import {
	_resetFileListCacheForTest,
	acquireFileListCache,
	getInvertedIndexHandle,
	hasFileListCacheEntry,
	releaseFileListCache,
} from "./search-cache";

const { buildIdleFillDeps, readForReindex } = __testing;

// buildIdleFillDeps は index handle を素通しするだけなので、read 経路の pin には
// 共通 fake で足りる。
const stubIndex = makeFakeIndex().handle;

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
		await expect(deps.readFile(normal)).resolves.toEqual({ text: "normal body", nlink: 1 });
		// 末端が symlink の file は reject する (呼び手の skipUntilEpochChange 経路に倒れる)。
		await expect(deps.readFile(swapped)).rejects.toThrow();
	});

	it("idle fill の readFile は読んだ fd の nlink を返す (#416 Finding 2)", async () => {
		const deps = buildIdleFillDeps(ws.dir, stubIndex);
		const hard = join(ws.dir, "hard.md");
		await fsp.link(normal, hard);

		await expect(deps.readFile(normal)).resolves.toEqual({ text: "normal body", nlink: 2 });
		await expect(deps.readFile(hard)).resolves.toEqual({ text: "normal body", nlink: 2 });
	});

	it("dark assert の再 index read は nlink !== 1 を null に倒す (#416 Finding 2)", async () => {
		const hard = join(ws.dir, "hard.md");
		await fsp.link(normal, hard);

		expect(await readForReindex(normal, ws.dir)).toBeNull();
		expect(await readForReindex(hard, ws.dir)).toBeNull();
	});

	it("dark assert の再 index read は nlink !== 1 を検出した path の posting を invalidate する (#416 Finding 2)", async () => {
		// 取り込み時は単一名で index に載り、後から hard link が作られた残る窓の終状態。
		acquireFileListCache(ws.dir);
		try {
			const h = getInvertedIndexHandle(ws.dir);
			if (h === undefined) throw new Error("handle should exist after acquire");
			h.indexFile(normal, "normal body", h.currentEpochOf(normal));
			expect(h.isIndexedAndValid(normal)).toBe(true);
			await fsp.link(normal, join(ws.dir, "hard.md"));

			expect(await readForReindex(normal, ws.dir)).toBeNull();
			expect(h.isIndexedAndValid(normal)).toBe(false);
		} finally {
			releaseFileListCache(ws.dir);
		}
	});

	it("dark assert の再 index read は末端 symlink を拒否して null を返す", async () => {
		// 読めない file は null = 「再検証できない」に倒す既存契約 (#405) は維持する。
		expect(await readForReindex(normal, ws.dir)).toBe("normal body");
		expect(await readForReindex(swapped, ws.dir)).toBeNull();
	});
});

describe("idle fill deps の entry 結線 (#589)", () => {
	let ws: TempWorkspace;

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-idle-deps-");
	});

	afterEach(async () => {
		_resetFileListCacheForTest();
		await ws.cleanup();
	});

	it("buildIdleFillDeps の isAlive は handle の entry identity を見る", () => {
		acquireFileListCache(ws.dir);
		const h = getInvertedIndexHandle(ws.dir);
		if (h === undefined) throw new Error("handle should exist after acquire");
		const deps = buildIdleFillDeps(ws.dir, h);
		expect(deps.isAlive()).toBe(true);
		releaseFileListCache(ws.dir);
		acquireFileListCache(ws.dir);
		expect(hasFileListCacheEntry(ws.dir)).toBe(true);
		expect(deps.isAlive()).toBe(false);
		releaseFileListCache(ws.dir);
	});

	it("buildIdleFillDeps の state は handle の idleFill そのもの", () => {
		acquireFileListCache(ws.dir);
		const h = getInvertedIndexHandle(ws.dir);
		if (h === undefined) throw new Error("handle should exist after acquire");
		const deps = buildIdleFillDeps(ws.dir, h);
		expect(deps.state).toBe(h.idleFill);
		releaseFileListCache(ws.dir);
	});
});
