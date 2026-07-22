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
	getCachedMdFiles,
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
		resolveWalk([p("a.md")]);
		const result = await pending;
		// walk 結果は caller に返る (query は成功)
		expect(result).toEqual([p("a.md")]);
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
