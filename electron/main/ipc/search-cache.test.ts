// @vitest-environment node
import { sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FsChangeEvent } from "../../../src/types/workspace";
import {
	applyBatchToState,
	buildExistingStemsFrom,
	buildFileMapFrom,
	canonicalToInputPaths,
	createCacheState,
	getExistingStems,
	getFileMap,
	getSortedFiles,
	setCacheFiles,
} from "../utils/search-cache-pure";
import {
	_resetFileListCacheForTest,
	acquireFileListCache,
	applyFsBatch,
	getCachedExistingStems,
	getCachedFileMap,
	getCachedInputFileMap,
	getCachedMdFiles,
	getContentCacheHandle,
	getInvertedIndexHandle,
	hasFileListCacheEntry,
	populateFileListCache,
	releaseFileListCache,
} from "./search-cache";

const ROOT = `${sep}ws${sep}notes`;
const p = (rel: string): string => `${ROOT}${sep}${rel.split("/").join(sep)}`;

afterEach(() => {
	_resetFileListCacheForTest();
});

describe("search-cache-pure: applyBatchToState", () => {
	it("marks .md create by adding to files set and bumps epoch", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		const epoch0 = s.epoch;
		applyBatchToState(s, [{ kind: "create", path: p("b.md") }]);
		expect(s.files).not.toBeNull();
		expect(s.files?.has(p("b.md"))).toBe(true);
		expect(s.epoch).toBe(epoch0 + 1);
	});

	it("marks .md delete by removing from files set and bumps epoch", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md"), p("b.md")]);
		const epoch0 = s.epoch;
		applyBatchToState(s, [{ kind: "delete", path: p("a.md") }]);
		expect(s.files?.has(p("a.md"))).toBe(false);
		expect(s.epoch).toBe(epoch0 + 1);
	});

	it(".md modify does not bump epoch (files unchanged for Phase A)", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		const epoch0 = s.epoch;
		applyBatchToState(s, [{ kind: "modify", path: p("a.md") }]);
		expect(s.epoch).toBe(epoch0);
	});

	it("re-adding an already-known .md does not bump epoch (idempotent)", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		const epoch0 = s.epoch;
		applyBatchToState(s, [{ kind: "create", path: p("a.md") }]);
		expect(s.epoch).toBe(epoch0);
	});

	it("deleting an unknown .md does not bump epoch (idempotent)", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		const epoch0 = s.epoch;
		applyBatchToState(s, [{ kind: "delete", path: p("z.md") }]);
		expect(s.epoch).toBe(epoch0);
	});

	it("non-.md create → full invalidate (dir event unknown; safe null)", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		const epoch0 = s.epoch;
		applyBatchToState(s, [{ kind: "create", path: p("subdir") }]);
		expect(s.files).toBeNull();
		expect(s.epoch).toBe(epoch0 + 1);
	});

	it("non-.md delete → full invalidate", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		applyBatchToState(s, [{ kind: "delete", path: p("subdir") }]);
		expect(s.files).toBeNull();
	});

	it("non-.md modify is ignored (settings 等の modification は無関係)", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		const epoch0 = s.epoch;
		applyBatchToState(s, [{ kind: "modify", path: p("settings.json") }]);
		expect(s.files?.has(p("a.md"))).toBe(true);
		expect(s.epoch).toBe(epoch0);
	});

	it("invalidates derived (sorted / fileMap / existing) on mutation", () => {
		const s = createCacheState();
		setCacheFiles(s, [p("a.md"), p("b.md")]);
		expect(getSortedFiles(s)).toEqual([p("a.md"), p("b.md")]);
		expect(getFileMap(s)?.size).toBe(2);
		expect(getExistingStems(s)?.size).toBe(2);
		applyBatchToState(s, [{ kind: "create", path: p("c.md") }]);
		// 直接 state.* を見て「dirty 化されているか」を検証する。次アクセスで再構築される。
		expect(s.sorted).toBeNull();
		expect(s.fileMap).toBeNull();
		expect(s.existingStems).toBeNull();
		expect(getSortedFiles(s)).toEqual([p("a.md"), p("b.md"), p("c.md")]);
	});

	it("continues bumping epoch after full-invalidate to signal further changes", () => {
		// files が null の間 (populate 進行中 / 既 invalidate) でも create/delete イベントは
		// 「workspace が変わった」信号として epoch を進める。populate 側の guard を作動させるため。
		const s = createCacheState();
		setCacheFiles(s, [p("a.md")]);
		applyBatchToState(s, [{ kind: "delete", path: p("subdir") }]);
		expect(s.files).toBeNull();
		const epoch1 = s.epoch;
		applyBatchToState(s, [{ kind: "create", path: p("x.md") }]);
		expect(s.epoch).toBe(epoch1 + 1);
		// modify 単発は無視される
		const epoch2 = s.epoch;
		applyBatchToState(s, [{ kind: "modify", path: p("y.md") }]);
		expect(s.epoch).toBe(epoch2);
	});
});

describe("search-cache-pure: derived builders", () => {
	it("buildFileMapFrom picks lexicographically smallest path per stem", () => {
		const map = buildFileMapFrom([p("z/foo.md"), p("a/foo.md"), p("m/foo.md")]);
		expect(map.get("foo")).toBe(p("a/foo.md"));
	});

	it("buildFileMapFrom skips non-.md files and empty stem (.md)", () => {
		const map = buildFileMapFrom([p("a.txt"), p(".md")]);
		expect(map.size).toBe(0);
	});

	it("buildExistingStemsFrom normalizes NFC", () => {
		// U+30D2 + U+309A (NFD form of pi) should be normalized to U+30D4 (NFC pi).
		// walkMdFiles may hand back an NFD basename on macOS HFS+ — Set must key on NFC.
		const nfdStem = "ピ";
		const set = buildExistingStemsFrom([p(`${nfdStem}.md`)]);
		expect(set.has("ピ")).toBe(true);
	});
});

describe("search-cache-pure: canonicalToInputPaths", () => {
	it("identity when canonicalRoot === inputRoot", () => {
		const files = [p("a.md"), p("sub/b.md")];
		const out = canonicalToInputPaths(files, ROOT, ROOT);
		expect(out).toEqual(files);
		expect(out).not.toBe(files); // returns a fresh array
	});

	it("substitutes prefix on symlink-style workspace", () => {
		const canonicalRoot = `${sep}private${sep}tmp${sep}ws`;
		const inputRoot = `${sep}tmp${sep}ws`;
		const canonical = [`${canonicalRoot}${sep}a.md`, `${canonicalRoot}${sep}sub${sep}b.md`];
		const out = canonicalToInputPaths(canonical, canonicalRoot, inputRoot);
		expect(out).toEqual([`${inputRoot}${sep}a.md`, `${inputRoot}${sep}sub${sep}b.md`]);
	});

	it("returns canonical unchanged when a path is outside the canonical root (defensive)", () => {
		const canonicalRoot = `${sep}ws${sep}a`;
		const inputRoot = `${sep}ws${sep}b`;
		const outsider = `${sep}elsewhere${sep}x.md`;
		const out = canonicalToInputPaths([outsider], canonicalRoot, inputRoot);
		expect(out).toEqual([outsider]);
	});
});

describe("search-cache: acquire / release refcount", () => {
	it("creates entry on first acquire and drops on last release", () => {
		expect(hasFileListCacheEntry(ROOT)).toBe(false);
		acquireFileListCache(ROOT);
		expect(hasFileListCacheEntry(ROOT)).toBe(true);
		releaseFileListCache(ROOT);
		expect(hasFileListCacheEntry(ROOT)).toBe(false);
	});

	it("keeps entry alive while refcount > 0 (multiple windows sharing a root)", () => {
		acquireFileListCache(ROOT);
		acquireFileListCache(ROOT);
		releaseFileListCache(ROOT);
		expect(hasFileListCacheEntry(ROOT)).toBe(true);
		releaseFileListCache(ROOT);
		expect(hasFileListCacheEntry(ROOT)).toBe(false);
	});

	it("release with no entry is a no-op (double-release tolerant)", () => {
		expect(() => releaseFileListCache(ROOT)).not.toThrow();
		expect(hasFileListCacheEntry(ROOT)).toBe(false);
	});
});

describe("search-cache: applyFsBatch", () => {
	it("no-ops when entry does not exist (release 済み / 未 acquire)", () => {
		// entry なしなので何が起きても throw しない、cache lookup は null のまま
		applyFsBatch(ROOT, [{ kind: "create", path: p("a.md") }]);
		expect(getCachedMdFiles(ROOT)).toBeNull();
	});

	it("applies to entry state when acquired", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		applyFsBatch(ROOT, [{ kind: "create", path: p("b.md") }]);
		expect(getCachedMdFiles(ROOT)).toEqual([p("a.md"), p("b.md")]);
	});

	it("full-invalidate on non-.md create → getCachedMdFiles null until re-populate", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		applyFsBatch(ROOT, [{ kind: "create", path: p("subdir") }]);
		expect(getCachedMdFiles(ROOT)).toBeNull();
		// 再 populate すれば hit するようになる
		const re = await populateFileListCache(ROOT, async () => [p("a.md"), p("b.md")]);
		expect(re).toEqual([p("a.md"), p("b.md")]);
		expect(getCachedMdFiles(ROOT)).toEqual([p("a.md"), p("b.md")]);
	});
});

describe("search-cache: populateFileListCache", () => {
	it("runs walk directly (without caching) when no entry (watcher 非稼働)", async () => {
		let called = 0;
		const files = await populateFileListCache(ROOT, async () => {
			called++;
			return [p("a.md")];
		});
		expect(files).toEqual([p("a.md")]);
		expect(called).toBe(1);
		expect(hasFileListCacheEntry(ROOT)).toBe(false);
	});

	it("stores result on entry when clean populate (no concurrent batch)", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		expect(getCachedMdFiles(ROOT)).toEqual([p("a.md")]);
	});

	it("dedupes concurrent populate calls (walk fn runs exactly once)", async () => {
		acquireFileListCache(ROOT);
		let called = 0;
		// deferred は same-tick 同時 populate で in-flight dedup 検証。
		// CLAUDE.md 記載の definite-assignment パターン (`let x!: T`) を使う。
		let resolveWalk!: (files: string[]) => void;
		const walkPromise = new Promise<string[]>((resolve) => {
			resolveWalk = resolve;
		});
		const walk = async (): Promise<readonly string[]> => {
			called++;
			return await walkPromise;
		};
		const p1 = populateFileListCache(ROOT, walk);
		const p2 = populateFileListCache(ROOT, walk);
		resolveWalk([p("a.md")]);
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(called).toBe(1);
		expect(r1).toEqual([p("a.md")]);
		expect(r2).toEqual([p("a.md")]);
	});

	it("does not store result when a batch arrived during populate (epoch guard)", async () => {
		acquireFileListCache(ROOT);
		let resolveWalk!: (files: string[]) => void;
		const walkPromise = new Promise<string[]>((resolve) => {
			resolveWalk = resolve;
		});
		const pending = populateFileListCache(ROOT, async () => await walkPromise);
		// populate 進行中に batch が来て epoch を進めるケース
		applyFsBatch(ROOT, [{ kind: "create", path: p("subdir") }]); // full invalidate
		// walk は unsorted な順序で返してくる (fs 走査順を模す)
		resolveWalk([p("z.md"), p("a.md"), p("m.md")]);
		const result = await pending;
		// walk 結果は caller に返る (query は成功) が、collectMdFilesForWorkspace の
		// 「常に sort 済み」不変条件を維持するため populate 側で byteCmp 済みにして返す。
		expect(result).toEqual([p("a.md"), p("m.md"), p("z.md")]);
		// cache には格納されない (次回 lookup は null で再 populate 必要)
		expect(getCachedMdFiles(ROOT)).toBeNull();
	});

	it("does not resurrect a released entry when in-flight walk resolves after release", async () => {
		acquireFileListCache(ROOT);
		let resolveWalk!: (files: string[]) => void;
		const walkPromise = new Promise<string[]>((resolve) => {
			resolveWalk = resolve;
		});
		const pending = populateFileListCache(ROOT, async () => await walkPromise);
		releaseFileListCache(ROOT);
		expect(hasFileListCacheEntry(ROOT)).toBe(false);
		resolveWalk([p("a.md")]);
		const result = await pending;
		// walk 結果は caller に返る
		expect(result).toEqual([p("a.md")]);
		// entry は復活しない
		expect(hasFileListCacheEntry(ROOT)).toBe(false);
		expect(getCachedMdFiles(ROOT)).toBeNull();
	});

	it("returns cached sorted array on subsequent populate without re-walk", async () => {
		acquireFileListCache(ROOT);
		let called = 0;
		await populateFileListCache(ROOT, async () => {
			called++;
			return [p("b.md"), p("a.md")];
		});
		const result = await populateFileListCache(ROOT, async () => {
			called++;
			return [];
		});
		expect(called).toBe(1);
		expect(result).toEqual([p("a.md"), p("b.md")]);
	});
});

describe("search-cache: sorted / fileMap / existingStems memoization", () => {
	it("getCachedMdFiles returns byteCmp-sorted array (lazy build once)", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("z.md"), p("a.md"), p("m.md")]);
		const s1 = getCachedMdFiles(ROOT);
		const s2 = getCachedMdFiles(ROOT);
		expect(s1).toEqual([p("a.md"), p("m.md"), p("z.md")]);
		// memo により同一参照が返る (dirty 化されなければ)
		expect(s1).toBe(s2);
	});

	it("re-builds sorted after invalidation", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		const s1 = getCachedMdFiles(ROOT);
		applyFsBatch(ROOT, [{ kind: "create", path: p("b.md") }]);
		const s2 = getCachedMdFiles(ROOT);
		expect(s1).toEqual([p("a.md")]);
		expect(s2).toEqual([p("a.md"), p("b.md")]);
		expect(s1).not.toBe(s2);
	});

	it("getCachedFileMap returns canonical stem→path map", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("z/foo.md"), p("a/foo.md")]);
		const map = getCachedFileMap(ROOT);
		expect(map?.get("foo")).toBe(p("a/foo.md"));
	});

	it("getCachedExistingStems includes all stems", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md"), p("b.md")]);
		const set = getCachedExistingStems(ROOT);
		expect(set?.has("a")).toBe(true);
		expect(set?.has("b")).toBe(true);
	});

	it("all derived accessors return null when entry not populated / invalidated", async () => {
		acquireFileListCache(ROOT);
		expect(getCachedMdFiles(ROOT)).toBeNull();
		expect(getCachedFileMap(ROOT)).toBeNull();
		expect(getCachedExistingStems(ROOT)).toBeNull();
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		expect(getCachedMdFiles(ROOT)).not.toBeNull();
		applyFsBatch(ROOT, [{ kind: "delete", path: p("dir") }]);
		expect(getCachedMdFiles(ROOT)).toBeNull();
		expect(getCachedFileMap(ROOT)).toBeNull();
		expect(getCachedExistingStems(ROOT)).toBeNull();
	});
});

describe("search-cache: batched multi-event apply", () => {
	it("handles a mixed batch (create + delete) in one call", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md"), p("b.md")]);
		const batch: FsChangeEvent[] = [
			{ kind: "delete", path: p("a.md") },
			{ kind: "create", path: p("c.md") },
		];
		applyFsBatch(ROOT, batch);
		expect(getCachedMdFiles(ROOT)).toEqual([p("b.md"), p("c.md")]);
	});

	it("stops processing after full-invalidate mid-batch", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		const batch: FsChangeEvent[] = [
			{ kind: "delete", path: p("subdir") }, // → null
			{ kind: "create", path: p("b.md") }, // 無視される (files 既 null)
		];
		applyFsBatch(ROOT, batch);
		expect(getCachedMdFiles(ROOT)).toBeNull();
	});
});

describe("search-cache: L2 ContentCache", () => {
	it("returns undefined handle when watcher is not running", () => {
		expect(getContentCacheHandle(ROOT)).toBeUndefined();
	});

	it("provides a handle after acquire and empty on first get", () => {
		acquireFileListCache(ROOT);
		const h = getContentCacheHandle(ROOT);
		expect(h).toBeDefined();
		expect(h?.get(p("a.md"))).toBeUndefined();
	});

	it("stores and retrieves text via handle", () => {
		acquireFileListCache(ROOT);
		const h = getContentCacheHandle(ROOT);
		const gen = h?.generation ?? 0;
		h?.set(p("a.md"), "hello", gen);
		expect(h?.get(p("a.md"))).toBe("hello");
	});

	it("release drops L2 alongside entry", () => {
		acquireFileListCache(ROOT);
		const h = getContentCacheHandle(ROOT);
		h?.set(p("a.md"), "hello", h.generation);
		releaseFileListCache(ROOT);
		expect(getContentCacheHandle(ROOT)).toBeUndefined();
	});

	describe("applyFsBatch evict", () => {
		it(".md modify evicts and bumps generation", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			h?.set(p("a.md"), "old", h.generation);
			const genBefore = h?.generation ?? 0;
			applyFsBatch(ROOT, [{ kind: "modify", path: p("a.md") }]);
			expect(h?.get(p("a.md"))).toBeUndefined();
			expect(h?.generation).toBe(genBefore + 1);
		});

		it(".md delete evicts and bumps generation", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			h?.set(p("a.md"), "old", h.generation);
			const genBefore = h?.generation ?? 0;
			applyFsBatch(ROOT, [{ kind: "delete", path: p("a.md") }]);
			expect(h?.get(p("a.md"))).toBeUndefined();
			expect(h?.generation).toBe(genBefore + 1);
		});

		it(".md create does not evict L2", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			h?.set(p("a.md"), "aaa", h.generation);
			const genBefore = h?.generation ?? 0;
			applyFsBatch(ROOT, [{ kind: "create", path: p("b.md") }]);
			expect(h?.get(p("a.md"))).toBe("aaa");
			expect(h?.generation).toBe(genBefore);
		});

		it("non-.md delete evicts subtree by prefix", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			h?.set(p("dir/a.md"), "aa", h.generation);
			h?.set(p("dir/b.md"), "bb", h.generation);
			h?.set(p("other.md"), "cc", h.generation);
			applyFsBatch(ROOT, [{ kind: "delete", path: p("dir") }]);
			expect(h?.get(p("dir/a.md"))).toBeUndefined();
			expect(h?.get(p("dir/b.md"))).toBeUndefined();
			expect(h?.get(p("other.md"))).toBe("cc");
		});

		it("does not evict via prefix false-match (/foo vs /foobar)", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			h?.set(p("foo"), "x", h.generation);
			h?.set(p("foobar/a.md"), "y", h.generation);
			applyFsBatch(ROOT, [{ kind: "delete", path: p("foo") }]);
			expect(h?.get(p("foo"))).toBeUndefined();
			expect(h?.get(p("foobar/a.md"))).toBe("y");
		});

		it("bumps generation on .md modify even when key is not cached (in-flight miss race)", () => {
			// regression: L2 miss で readFile 中の file 自身が modify されたケース =
			// stale-insert race の本命。L2 に無いから delete が false でも generation を
			// bump しないと、readFile 完了時の set が古い text を格納してしまう。
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			const genAtStart = h?.generation ?? 0;
			// pretend scan miss + readFile start: capture generation, no cache entry yet
			applyFsBatch(ROOT, [{ kind: "modify", path: p("a.md") }]);
			expect(h?.generation).toBe(genAtStart + 1);
			// stale set with old generation must be rejected
			h?.set(p("a.md"), "stale", genAtStart);
			expect(h?.get(p("a.md"))).toBeUndefined();
		});

		it("bumps generation on .md delete even when key is not cached", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			const genAtStart = h?.generation ?? 0;
			applyFsBatch(ROOT, [{ kind: "delete", path: p("a.md") }]);
			expect(h?.generation).toBe(genAtStart + 1);
		});

		it("does not bump generation on .md create (no in-flight race)", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			const genAtStart = h?.generation ?? 0;
			applyFsBatch(ROOT, [{ kind: "create", path: p("new.md") }]);
			expect(h?.generation).toBe(genAtStart);
		});

		it("bumps generation on non-.md events regardless of L2 content", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			const genAtStart = h?.generation ?? 0;
			applyFsBatch(ROOT, [{ kind: "create", path: p("subdir") }]);
			expect(h?.generation).toBe(genAtStart + 1);
		});

		it("stale set (mismatched generation) is silently dropped", () => {
			acquireFileListCache(ROOT);
			const h = getContentCacheHandle(ROOT);
			// pre-populate so that the subsequent modify actually evicts and bumps generation
			h?.set(p("a.md"), "cached", h.generation);
			const genAtStart = h?.generation ?? 0;
			applyFsBatch(ROOT, [{ kind: "modify", path: p("a.md") }]);
			// pretend a readFile started before the modify: try to set with old gen
			h?.set(p("a.md"), "stale", genAtStart);
			expect(h?.get(p("a.md"))).toBeUndefined();
		});
	});
});

describe("search-cache: getCachedInputFileMap (candidate C)", () => {
	it("returns null when entry is missing", () => {
		expect(getCachedInputFileMap(ROOT, ROOT)).toBeNull();
	});

	it("returns null before populate", () => {
		acquireFileListCache(ROOT);
		expect(getCachedInputFileMap(ROOT, ROOT)).toBeNull();
	});

	it("returns canonical map directly when canonicalRoot === inputRoot", async () => {
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md"), p("b.md")]);
		const canonical = getCachedFileMap(ROOT);
		const input = getCachedInputFileMap(ROOT, ROOT);
		expect(input).toBe(canonical);
	});

	it("substitutes root prefix when inputRoot differs from canonicalRoot", async () => {
		// canonical = /ws/notes, input = /ws/alias (symlink root case)
		const INPUT_ROOT = `${sep}ws${sep}alias`;
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md"), p("sub/b.md")]);
		const input = getCachedInputFileMap(ROOT, INPUT_ROOT);
		expect(input?.get("a")).toBe(`${INPUT_ROOT}${sep}a.md`);
		expect(input?.get("b")).toBe(`${INPUT_ROOT}${sep}sub${sep}b.md`);
	});

	it("memoizes result across calls with same inputRoot", async () => {
		const INPUT_ROOT = `${sep}ws${sep}alias`;
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		const m1 = getCachedInputFileMap(ROOT, INPUT_ROOT);
		const m2 = getCachedInputFileMap(ROOT, INPUT_ROOT);
		expect(m1).toBe(m2);
	});

	it("invalidates memo on epoch change (batch that bumps L1)", async () => {
		const INPUT_ROOT = `${sep}ws${sep}alias`;
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		const m1 = getCachedInputFileMap(ROOT, INPUT_ROOT);
		applyFsBatch(ROOT, [{ kind: "create", path: p("b.md") }]);
		const m2 = getCachedInputFileMap(ROOT, INPUT_ROOT);
		expect(m2).not.toBe(m1);
		expect(m2?.get("b")).toBe(`${INPUT_ROOT}${sep}b.md`);
	});

	it("rebuilds when inputRoot differs from memoized inputRoot", async () => {
		const INPUT_A = `${sep}ws${sep}aliasA`;
		const INPUT_B = `${sep}ws${sep}aliasB`;
		acquireFileListCache(ROOT);
		await populateFileListCache(ROOT, async () => [p("a.md")]);
		const mA = getCachedInputFileMap(ROOT, INPUT_A);
		const mB = getCachedInputFileMap(ROOT, INPUT_B);
		expect(mA?.get("a")).toBe(`${INPUT_A}${sep}a.md`);
		expect(mB?.get("a")).toBe(`${INPUT_B}${sep}a.md`);
		expect(mA).not.toBe(mB);
	});
});

describe("L3 InvertedIndex integration", () => {
	it("getInvertedIndexHandle is defined right after acquire, undefined after release", () => {
		expect(getInvertedIndexHandle(ROOT)).toBeUndefined();
		acquireFileListCache(ROOT);
		expect(getInvertedIndexHandle(ROOT)).toBeDefined();
		releaseFileListCache(ROOT);
		expect(getInvertedIndexHandle(ROOT)).toBeUndefined();
	});

	describe("applyFsBatch L3 branch", () => {
		it(".md create is a no-op for L3 (new file is not indexed yet)", () => {
			acquireFileListCache(ROOT);
			const h = getInvertedIndexHandle(ROOT);
			h?.indexFile(p("a.md"), "hello world", h.currentEpochOf(p("a.md")));
			applyFsBatch(ROOT, [{ kind: "create", path: p("b.md") }]);
			const result = h?.getCandidates("hello");
			expect(result?.kind).toBe("candidates");
			if (result?.kind === "candidates") {
				// a.md は create の影響を受けず valid のまま、b.md は未 index のまま candidate に出ない
				expect(result.indexedValid.has(p("a.md"))).toBe(true);
				expect(result.candidates.has(p("b.md"))).toBe(false);
			}
		});

		it(".md modify invalidates the file (posting kept, epoch bumped → excluded from indexedValid)", () => {
			acquireFileListCache(ROOT);
			const h = getInvertedIndexHandle(ROOT);
			h?.indexFile(p("a.md"), "hello world", h.currentEpochOf(p("a.md")));
			let result = h?.getCandidates("hello");
			expect(result?.kind).toBe("candidates");
			if (result?.kind === "candidates") {
				expect(result.indexedValid.has(p("a.md"))).toBe(true);
			}
			applyFsBatch(ROOT, [{ kind: "modify", path: p("a.md") }]);
			result = h?.getCandidates("hello");
			expect(result?.kind).toBe("candidates");
			if (result?.kind === "candidates") {
				expect(result.indexedValid.has(p("a.md"))).toBe(false);
			}
		});

		it(".md delete removes the file (indexedEpoch cleared, currentEpochOf bumps)", () => {
			acquireFileListCache(ROOT);
			const h = getInvertedIndexHandle(ROOT);
			h?.indexFile(p("a.md"), "hello world", h.currentEpochOf(p("a.md")));
			const epochBefore = h?.currentEpochOf(p("a.md")) ?? 0;
			applyFsBatch(ROOT, [{ kind: "delete", path: p("a.md") }]);
			const epochAfter = h?.currentEpochOf(p("a.md")) ?? 0;
			expect(epochAfter).toBeGreaterThan(epochBefore);
			const result = h?.getCandidates("hello");
			expect(result?.kind).toBe("candidates");
			if (result?.kind === "candidates") {
				expect(result.indexedValid.has(p("a.md"))).toBe(false);
			}
		});

		it("non-.md path invalidates the subtree (exact + prefix, same判定 as L2 deletePrefix)", () => {
			acquireFileListCache(ROOT);
			const h = getInvertedIndexHandle(ROOT);
			// tombstone 全 clear (indexedValidCount の 50%超) を誘発しないよう、
			// 3 file 目 (other2.md) を追加して invalidate 後も validCount >= 2 を保つ
			// (InvertedIndex.maybeClearOnTombstoneRatio、電main/utils/inverted-index.ts 参照)。
			h?.indexFile(p("dir/a.md"), "hello world", h.currentEpochOf(p("dir/a.md")));
			h?.indexFile(p("other.md"), "hello world", h.currentEpochOf(p("other.md")));
			h?.indexFile(p("other2.md"), "hello world", h.currentEpochOf(p("other2.md")));
			applyFsBatch(ROOT, [{ kind: "delete", path: p("dir") }]);
			const result = h?.getCandidates("hello");
			expect(result?.kind).toBe("candidates");
			if (result?.kind === "candidates") {
				expect(result.indexedValid.has(p("dir/a.md"))).toBe(false);
				expect(result.indexedValid.has(p("other.md"))).toBe(true);
				expect(result.indexedValid.has(p("other2.md"))).toBe(true);
			}
		});
	});

	it("piggyback epoch race: indexFile with a stale capturedEpoch is discarded", () => {
		acquireFileListCache(ROOT);
		const h = getInvertedIndexHandle(ROOT);
		// 事前に file を index 済みにしておく (pathToId 登録がないと invalidate が no-op になるため)。
		// tombstone 全 clear を避けるため 3 file 分登録しておく。
		h?.indexFile(p("a.md"), "irrelevant text", h.currentEpochOf(p("a.md")));
		h?.indexFile(p("b.md"), "irrelevant text", h.currentEpochOf(p("b.md")));
		h?.indexFile(p("c.md"), "irrelevant text", h.currentEpochOf(p("c.md")));
		// read 前に epoch を snapshot する。
		const capturedEpoch = h?.currentEpochOf(p("a.md")) ?? 0;
		// read 中に modify batch が来て epoch が bump される。
		applyFsBatch(ROOT, [{ kind: "modify", path: p("a.md") }]);
		// read 完了後、古い capturedEpoch で indexFile を呼ぶ → 破棄される。
		h?.indexFile(p("a.md"), "hello world", capturedEpoch);
		const result = h?.getCandidates("hello");
		expect(result?.kind).toBe("candidates");
		if (result?.kind === "candidates") {
			expect(result.indexedValid.has(p("a.md"))).toBe(false);
			expect(result.candidates.has(p("a.md"))).toBe(false);
		}
	});

	describe("verify (SCRIPTA_DARK_ASSERT smoke)", () => {
		it("does not throw when hits are within the candidate/unindexed superset", () => {
			acquireFileListCache(ROOT);
			const h = getInvertedIndexHandle(ROOT);
			h?.indexFile(p("a.md"), "hello world", h.currentEpochOf(p("a.md")));
			h?.indexFile(p("b.md"), "goodbye world", h.currentEpochOf(p("b.md")));
			expect(() =>
				h?.verify("hello", false, [p("a.md"), p("b.md")], [p("a.md")]),
			).not.toThrow();
		});

		it("throws when a hit file is outside the allowed set", () => {
			acquireFileListCache(ROOT);
			const h = getInvertedIndexHandle(ROOT);
			h?.indexFile(p("a.md"), "hello world", h.currentEpochOf(p("a.md")));
			h?.indexFile(p("b.md"), "goodbye world", h.currentEpochOf(p("b.md")));
			expect(() =>
				h?.verify("hello", false, [p("a.md"), p("b.md")], [p("b.md")]),
			).toThrow();
		});
	});

	it("a handle held past release becomes stale: indexFile is a no-op", () => {
		acquireFileListCache(ROOT);
		const h = getInvertedIndexHandle(ROOT);
		expect(h).toBeDefined();
		releaseFileListCache(ROOT);
		// stale handle 経由の呼び出しは throw せず、かつ再 acquire した新 entry へ漏れ書き込みしない。
		expect(() => h?.indexFile(p("a.md"), "hello world", 0)).not.toThrow();
		acquireFileListCache(ROOT);
		const freshHandle = getInvertedIndexHandle(ROOT);
		const result = freshHandle?.getCandidates("hello");
		expect(result?.kind).toBe("candidates");
		if (result?.kind === "candidates") {
			expect(result.indexedValid.has(p("a.md"))).toBe(false);
		}
	});
});
