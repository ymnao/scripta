// @vitest-environment node
//
// piggyback indexing のゲート (#413) を processMdFilesParallel 単体で固定する。
// - Finding 1: index が disabled なら realpath ゲート (resolveInsideRoot) を一切呼ばない。
// - Finding 2: 解決先が入力 path と異なる file (workspace 内 alias) は index / L2 に載せない。
//
// realpath 呼び出し回数を数えるため path-guard を partial mock する。mock は module 単位で
// 効くので、実 path-guard に依存する search.test.ts とは別ファイルに切る。
import { realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

vi.mock("../utils/path-guard", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/path-guard")>();
	return {
		...actual,
		// 実挙動はそのままに呼び出し回数だけ観測する。
		resolveInsideRoot: vi.fn(actual.resolveInsideRoot),
	};
});

import { createTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import { resolveInsideRoot } from "../utils/path-guard";
import { __testing } from "./search";
import type { ContentCacheHandle, InvertedIndexHandle } from "./search-cache";

const { processMdFilesParallel } = __testing;

let ws: TempWorkspace;
let root = "";

beforeEach(async () => {
	vi.mocked(resolveInsideRoot).mockClear();
	ws = await createTempWorkspace("scripta-index-gate-");
	// walk 結果と同じく canonical 側の path を使う (非 alias なら resolved === ioPath)。
	root = await realpath(ws.dir);
});

afterEach(async () => {
	await ws.cleanup();
});

interface FakeIndex {
	handle: InvertedIndexHandle;
	indexed: Map<string, string>;
	disabled: { value: boolean };
}

function makeFakeIndex(): FakeIndex {
	const indexed = new Map<string, string>();
	const disabled = { value: false };
	const handle: InvertedIndexHandle = {
		indexFile(ioPath: string, text: string, _capturedEpoch: number): void {
			indexed.set(ioPath, text);
		},
		currentEpochOf(_ioPath: string): number {
			return 0;
		},
		isIndexedAndValid(ioPath: string): boolean {
			return indexed.has(ioPath);
		},
		getCandidates() {
			return { kind: "fallback" } as const;
		},
		verify(): void {},
		collectViolations(): string[] | null {
			return null;
		},
		get isDisabled(): boolean {
			return disabled.value;
		},
	};
	return { handle, indexed, disabled };
}

function makeFakeCache(preloaded: Map<string, string>): {
	cache: ContentCacheHandle;
	stored: Map<string, string>;
} {
	const stored = new Map<string, string>();
	const cache: ContentCacheHandle = {
		get(ioPath: string): string | undefined {
			return preloaded.get(ioPath);
		},
		set(ioPath: string, text: string, _capturedGeneration: number): void {
			stored.set(ioPath, text);
		},
		get generation(): number {
			return 0;
		},
	};
	return { cache, stored };
}

const never = (): boolean => false;

describe("processMdFilesParallel: index disabled ゲート (#413 Finding 1)", () => {
	it("L2-miss 経路: disabled ならゲートも indexFile も走らないが scan と L2 population は続く", async () => {
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		await writeFile(a, "alpha");
		await writeFile(b, "beta");
		const { handle, indexed, disabled } = makeFakeIndex();
		disabled.value = true;
		const { cache, stored } = makeFakeCache(new Map());
		const scanned: string[] = [];

		await processMdFilesParallel([a, b], [a, b], never, {
			index: handle,
			indexRoot: root,
			cache,
			process: (inFile, text) => {
				scanned.push(`${inFile}:${text}`);
			},
		});

		expect(vi.mocked(resolveInsideRoot)).not.toHaveBeenCalled();
		expect(indexed.size).toBe(0);
		// index を通らなくても scan (検索結果) は従来どおり全 file 分行われる。
		expect(scanned.sort()).toEqual([`${a}:alpha`, `${b}:beta`]);
		// **ゲート未評価の file は L2 に載せ続ける**。ここを止めると disabled workspace で
		// L2 population が全停止して検索が毎回全 file 再読になる。search.ts の
		// `!indexGateEvaluated || indexable` の前半が消える退行を殺すための assert。
		expect(stored.size).toBe(2);
	});

	it("L2-hit 経路: disabled なら realpath ゲートも indexFile も走らない", async () => {
		const a = join(root, "a.md");
		await writeFile(a, "alpha on disk");
		const { handle, indexed, disabled } = makeFakeIndex();
		disabled.value = true;
		const { cache } = makeFakeCache(new Map([[a, "alpha cached"]]));
		const scanned: string[] = [];

		await processMdFilesParallel([a], [a], never, {
			index: handle,
			indexRoot: root,
			cache,
			process: (_inFile, text) => {
				scanned.push(text);
			},
		});

		expect(vi.mocked(resolveInsideRoot)).not.toHaveBeenCalled();
		expect(indexed.size).toBe(0);
		expect(scanned).toEqual(["alpha cached"]);
	});

	it("disabled でなければ従来どおりゲートを通って index される (L2-miss / L2-hit 双方)", async () => {
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		await writeFile(a, "alpha");
		await writeFile(b, "beta");
		const { handle, indexed } = makeFakeIndex();
		const { cache } = makeFakeCache(new Map([[b, "beta cached"]]));

		await processMdFilesParallel([a, b], [a, b], never, {
			index: handle,
			indexRoot: root,
			cache,
			process: () => {},
		});

		expect(vi.mocked(resolveInsideRoot)).toHaveBeenCalledTimes(2);
		expect(indexed.get(a)).toBe("alpha"); // L2-miss 経路
		expect(indexed.get(b)).toBe("beta cached"); // L2-hit 経路
	});
});

// symlink 作成が要るので win32 では skip (既存の #406 suite と同方針)。
describe.skipIf(process.platform === "win32")(
	"processMdFilesParallel: alias は index / L2 に載せない (#413 Finding 2)",
	() => {
		it("L2-miss 経路: 解決先が入力 path と異なる file は indexFile も cache.set もしない", async () => {
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { handle, indexed } = makeFakeIndex();
			const { cache, stored } = makeFakeCache(new Map());
			const scanned: string[] = [];

			await processMdFilesParallel([real, link], [real, link], never, {
				index: handle,
				indexRoot: root,
				cache,
				process: (inFile, text) => {
					scanned.push(`${inFile}:${text}`);
				},
			});

			// 実体は従来どおり index / L2 に載る。
			expect(indexed.has(real)).toBe(true);
			expect(stored.has(real)).toBe(true);
			// alias は index にも L2 にも載らない。
			expect(indexed.has(link)).toBe(false);
			expect(stored.has(link)).toBe(false);
			// scan (検索結果) には従来どおり両方出る。
			expect(scanned.sort()).toEqual([`${link}:alphaword body`, `${real}:alphaword body`]);
		});

		it("L2-hit 経路: alias は cache hit しても indexFile しない", async () => {
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { handle, indexed } = makeFakeIndex();
			const { cache } = makeFakeCache(new Map([[link, "alphaword cached"]]));
			const scanned: string[] = [];

			await processMdFilesParallel([link], [link], never, {
				index: handle,
				indexRoot: root,
				cache,
				process: (_inFile, text) => {
					scanned.push(text);
				},
			});

			expect(indexed.has(link)).toBe(false);
			expect(scanned).toEqual(["alphaword cached"]);
		});
	},
);
