import type { FsChangeEvent } from "../../../src/types/workspace";
import {
	applyBatchToState,
	createCacheState,
	type FileListCacheState,
	getExistingStems,
	getFileMap,
	getSortedFiles,
	setCacheFiles,
} from "../utils/search-cache-pure";

// canonical workspace root ごとに FileListCache を持つ。
// entry 存在 = watcher 稼働中 という不変条件を保つことで、
// 「watcher 非稼働時は cache を使わない」判定を entry 有無 1 つで表現する。
//
// refCount は同一 root を複数 window (watcher session) が共有するケース用。
// window close (stopWatcherForWindow) で -1 し、0 で Map から drop する。
interface CacheEntry {
	refCount: number;
	state: FileListCacheState;
	inFlight: Promise<readonly string[]> | null;
}

const entries = new Map<string, CacheEntry>();

// watcher:start 成功時に呼ぶ。同一 canonical root の 2 セッション目は refCount +1 のみ。
export function acquireFileListCache(canonicalRoot: string): void {
	const e = entries.get(canonicalRoot);
	if (e === undefined) {
		entries.set(canonicalRoot, {
			refCount: 1,
			state: createCacheState(),
			inFlight: null,
		});
	} else {
		e.refCount++;
	}
}

// stopWatcherForWindow 末尾で呼ぶ。0 到達で drop し、以降の cache lookup が miss になる。
// entry がなければ no-op (ダブル release 耐性)。
export function releaseFileListCache(canonicalRoot: string): void {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return;
	e.refCount--;
	if (e.refCount <= 0) entries.delete(canonicalRoot);
}

// watcher flush 直後に呼ぶ。entry がなければ no-op (release 済み / 未 acquire)。
export function applyFsBatch(canonicalRoot: string, batch: ReadonlyArray<FsChangeEvent>): void {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return;
	applyBatchToState(e.state, batch);
}

// cache hit の canonical file 配列を返す。populated & valid でなければ null。
// null 時は caller が populateFileListCache を呼ぶか、watcher 非稼働なら直接 walk する。
export function getCachedMdFiles(canonicalRoot: string): readonly string[] | null {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return null;
	return getSortedFiles(e.state);
}

// watcher 稼働中かつ未 populate の場合に walk 結果を格納する。
// - entry なし (watcher 非稼働): 単に walk を実行して結果を返す (cache しない)。
// - entry あり + populated: 既存 sorted を返す (walk しない)。
// - entry あり + in-flight: 進行中の promise に相乗り (walk 1 回に集約)。
// - entry あり + 未 populate: walk 実行。完了時に epoch guard で
//   「populate 中に batch が来ていない」ことを確認してから格納する。
//   guard 失敗時も walk 結果は呼び出し元へ返す (query は成功、cache だけ見送り)。
// release 後に in-flight が解決した場合、entry は Map から消えているため復活しない。
export async function populateFileListCache(
	canonicalRoot: string,
	walk: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
	const e = entries.get(canonicalRoot);
	if (e === undefined) {
		// watcher 非稼働 → cache しないで直接 walk
		return await walk();
	}
	// 既に populated (batch 適用のみで invalidate されていない場合) はそのまま返す
	const already = getSortedFiles(e.state);
	if (already !== null) return already;
	if (e.inFlight !== null) return e.inFlight;

	const epochAtStart = e.state.epoch;
	// CLAUDE.md 記載の deferred-self-reference パターン: 「executor 内で外側の promise 変数を
	// 参照する」ため let!: T (definite assignment) を使う。IIFE 実行順序上 promise は
	// finally 到達前に必ず代入されているが、TS の CFA は nested function 内の代入前参照を
	// TS2454 として返すためこの workaround が必要。
	let promise!: Promise<readonly string[]>;
	promise = (async (): Promise<readonly string[]> => {
		try {
			const result = await walk();
			const current = entries.get(canonicalRoot);
			if (current === e && current.state.epoch === epochAtStart) {
				setCacheFiles(current.state, result);
				const sorted = getSortedFiles(current.state);
				return sorted ?? result;
			}
			return result;
		} finally {
			if (e.inFlight === promise) e.inFlight = null;
		}
	})();
	e.inFlight = promise;
	return promise;
}

export function getCachedFileMap(canonicalRoot: string): ReadonlyMap<string, string> | null {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return null;
	return getFileMap(e.state);
}

export function getCachedExistingStems(canonicalRoot: string): ReadonlySet<string> | null {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return null;
	return getExistingStems(e.state);
}

// test 用: module state を全リセットする。production コードから呼んではならない。
export function _resetFileListCacheForTest(): void {
	entries.clear();
}

// watcher 稼働中 (= cache entry あり) かどうかを判定する。
// collectMdFilesForWorkspace が「populate 経由か直接 walk か」を分岐するため、
// および test 用途で使う。
export function hasFileListCacheEntry(canonicalRoot: string): boolean {
	return entries.has(canonicalRoot);
}
