import { sep } from "node:path";
import type { FsChangeEvent } from "../../../src/types/workspace";
import { ByteLruCache } from "../utils/content-cache-pure";
import { type CandidateResult, InvertedIndex, verifyIndexSuperset } from "../utils/inverted-index";
import {
	applyBatchToState,
	canonicalToInputPaths,
	createCacheState,
	type FileListCacheState,
	getExistingStems,
	getFileMap,
	getSortedFiles,
	setCacheFiles,
	sortWalkResult,
} from "../utils/search-cache-pure";

// canonical workspace root ごとに FileListCache を持つ。
// entry 存在 = watcher 稼働中 という不変条件を保つことで、
// 「watcher 非稼働時は cache を使わない」判定を entry 有無 1 つで表現する。
//
// refCount は同一 root を複数 window (watcher session) が共有するケース用。
// window close (stopWatcherForWindow) で -1 し、0 で Map から drop する。
// inputRoot ごとに派生する input-form fileMap の memo。同一 canonical root に複数 window
// (異なる inputRoot) が張り付くケースは稀なので single slot で十分。mismatch 時は作り直す。
// epoch が変われば破棄する (L1 files 集合の invalidation と連動)。
interface InputFileMapMemo {
	epoch: number;
	inputRoot: string;
	map: ReadonlyMap<string, string>;
}

interface CacheEntry {
	refCount: number;
	state: FileListCacheState;
	inFlight: Promise<readonly string[]> | null;
	// L2 ContentCache: canonical ioPath → readFile 済み string の byte 予算 LRU。
	// entry のライフサイクルに便乗して、release (refCount 0) で自然に drop される。
	l2: ByteLruCache;
	// L2 の invalidation generation。read 開始前に capture して set 時に不一致なら破棄する
	// (readFile 中に modify batch が来て evict された場合の stale-insert race 対策)。
	// L1 epoch は modify で bump しないため専用カウンタが必要。
	l2Generation: number;
	// input-form fileMap の派生 memo (candidate C)。scanBacklinksImpl が使う。
	inputFileMapMemo: InputFileMapMemo | null;
	// L3 InvertedIndex: bigram 転置索引 (Phase C、dark-launch)。
	// L1/L2 と同じ applyFsBatch で invalidation を同期する。
	// entry のライフサイクルに便乗して、release で自然に drop される。
	// **粒度メモ**: L2 は key ごとの identity を持たない (LRU 単位で cache key ごとに存在有無を
	// 追うだけ) ため single global generation (l2Generation) で足りるが、L3 は file 単位で
	// posting の valid/stale 判定 + tombstone 比率計算が必要なため per-file fileEpoch を持つ。
	// 両者は「意図ベース bump」の姉妹だが実装粒度は異なる — Phase D で共通 primitive に統合
	// しようとしても L2 の global generation では L3 の tombstone 計算を表現できないため、
	// 誤って同一 counter に括ってはならない。
	l3: InvertedIndex;
}

// L2 に読み書きするための狭い interface。processMdFilesParallel はこの handle 経由で
// L2 に触るため、helper 側は search-cache module state を直接 import しない
// (helper の独立テスト性を保つ)。
export interface ContentCacheHandle {
	get(ioPath: string): string | undefined;
	// set は capture した generation を渡す。set 時点で最新 generation と不一致なら
	// 黙って捨てる (stale-insert race 対策)。
	set(ioPath: string, text: string, capturedGeneration: number): void;
	readonly generation: number;
}

// L3 InvertedIndex の handle。piggyback indexing は processMdFilesParallel の
// text 確定点で `indexFile` を呼ぶ (fire-and-forget、read 前後で epoch snapshot 照合)。
// getCandidates / verify は Phase C では dark-launch assert からのみ呼ぶ (production 経路
// では未使用、Phase D で searchFilesImpl 本配線)。
export interface InvertedIndexHandle {
	indexFile(ioPath: string, text: string, capturedEpoch: number): void;
	currentEpochOf(ioPath: string): number;
	isIndexedAndValid(ioPath: string): boolean;
	getCandidates(queryLower: string): CandidateResult;
	verify(
		query: string,
		caseSensitive: boolean,
		allIoFiles: readonly string[],
		hitIoFiles: readonly string[],
	): void;
	readonly isDisabled: boolean;
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
			l2: new ByteLruCache(),
			l2Generation: 0,
			inputFileMapMemo: null,
			l3: new InvertedIndex(),
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
// L1 (files 集合) の反映と L2 (ContentCache) の evict を同一 batch で処理する。
// L1 側は applyBatchToState、L2 側は本関数内で分岐する。
// - `.md` modify/delete → L2 の該当 ioPath を delete
// - `.md` create → L2 は無操作 (新規なので cache 側にはない)
// - 非 `.md` create/delete → dir イベントかもしれないので L2 の該当 subtree (path + sep prefix) と
//   exact path 一致を deletePrefix で一括削除。L1 側の保守的 full invalidate と対応する
// **generation bump は evict の成否ではなく「invalidation の意図」で判定する**。
// 具体的には .md modify/delete および非 .md create/delete/modify の全てで bump する
// (.md create のみ bump しない — 新規 file なので進行中の scan の in-flight read と競合しない)。
// これは「L2 miss で readFile 中の file 自身が modify された」ケース = 本命の
// stale-insert race を防ぐため。delete 成否で判定すると、cache に無い (=まさに読み中の)
// key に対する modify で generation が進まず、readFile 完了時の set が古い text を格納する。
// Phase A の applyBatchToState が files === null 中も epoch を bump する保守側倒しと同方針。
// inputFileMapMemo は epoch 依存なので、L1 側で epoch が進んだかを比較して invalidate する。
export function applyFsBatch(canonicalRoot: string, batch: ReadonlyArray<FsChangeEvent>): void {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return;
	const epochBefore = e.state.epoch;
	applyBatchToState(e.state, batch);
	let shouldBumpL2 = false;
	for (const ev of batch) {
		const isMd = ev.path.endsWith(".md");
		if (isMd) {
			if (ev.kind === "create") continue; // 新規 file → race 対象外
			e.l2.delete(ev.path);
			shouldBumpL2 = true;
			// L3: modify → invalidate (posting 残置 + fileEpoch bump)、
			//     delete → remove (indexedEpoch 削除 + fileEpoch bump、posting 残置は tombstone clear で回収)。
			if (ev.kind === "delete") {
				e.l3.remove(ev.path);
			} else {
				e.l3.invalidate(ev.path);
			}
		} else {
			// 非 .md の全 event: dir 可能性を考慮して subtree + exact 一括 evict + bump
			const prefixWithSep = ev.path.endsWith(sep) ? ev.path : ev.path + sep;
			e.l2.deletePrefix(ev.path, prefixWithSep);
			shouldBumpL2 = true;
			// L3 も同範囲を invalidate (L2 deletePrefix と同じ判定)。
			e.l3.invalidatePrefix(ev.path);
		}
	}
	if (shouldBumpL2) e.l2Generation++;
	// epoch が進んだ場合、input-form fileMap memo は L1 に依存するため破棄。
	if (e.state.epoch !== epochBefore) e.inputFileMapMemo = null;
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
				// setCacheFiles で state.files を非 null にした直後なので getSortedFiles は必ず配列を返す。
				return getSortedFiles(current.state) as readonly string[];
			}
			// epoch guard 失敗: 格納しないが caller には byteCmp 済みで返す
			// (collectMdFilesForWorkspace の「常に sort 済み」不変条件を維持するため)。
			return sortWalkResult(result);
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

// candidate C: input-form fileMap の派生 memo。
// walkMdFiles は entry symlink を解決しないため、canonical fileMap の値は
// 「canonical root + walk したままの相対パス」の形をしている。この不変条件を利用して、
// canonical fileMap の value の root prefix を inputRoot に差し替えるだけで input-form
// fileMap が得られる。inputRoot === canonicalRoot の common case では canonical fileMap を
// そのまま返す (コピー不要)。
// scanBacklinksImpl の workspace 内 symlink note 対応と両立するのがこの方式の要点。
// 前提: walk が entry symlink を解決しない (fs.readdir の contract)。将来 walk が symlink を
// 解決するよう変わるとこの前提が崩れるので、変更時はこの comment を確認すること。
export function getCachedInputFileMap(
	canonicalRoot: string,
	inputRoot: string,
): ReadonlyMap<string, string> | null {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return null;
	const canonicalMap = getFileMap(e.state);
	if (canonicalMap === null) return null;
	if (canonicalRoot === inputRoot) return canonicalMap;
	const memo = e.inputFileMapMemo;
	if (memo !== null && memo.epoch === e.state.epoch && memo.inputRoot === inputRoot) {
		return memo.map;
	}
	// canonicalToInputPaths と同じ prefix 差替ロジックを Map の value 側に適用する。
	// entries を 1 度舐めて keys / values を並行に取り、変換後に zip し直す
	// (canonicalMap 反復順序 = values() 反復順序の spec 保証を利用)。
	const keys: string[] = [];
	const values: string[] = [];
	for (const [k, v] of canonicalMap) {
		keys.push(k);
		values.push(v);
	}
	const inputPaths = canonicalToInputPaths(values, canonicalRoot, inputRoot);
	const built = new Map<string, string>();
	for (let i = 0; i < keys.length; i++) {
		built.set(keys[i], inputPaths[i]);
	}
	e.inputFileMapMemo = { epoch: e.state.epoch, inputRoot, map: built };
	return built;
}

// L2 に読み書きするための handle を返す。entry がなければ undefined (watcher 非稼働時は
// L2 未経由で従来の readFile 経路になる)。
// handle.set は capturedGeneration が生成時と現在で一致するときのみ格納する
// (stale-insert race 対策)。
export function getContentCacheHandle(canonicalRoot: string): ContentCacheHandle | undefined {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return undefined;
	return {
		get(ioPath: string): string | undefined {
			return e.l2.get(ioPath);
		},
		set(ioPath: string, text: string, capturedGeneration: number): void {
			// entry が map から drop されていた場合、この closure は古い entry を掴んだままだが、
			// generation は entry-local なので比較は生きる。ただし drop 済み entry の l2 に書き込む
			// 意味はないので entries.get で存在チェックする。
			const current = entries.get(canonicalRoot);
			if (current !== e) return;
			if (e.l2Generation !== capturedGeneration) return;
			e.l2.set(ioPath, text);
		},
		get generation(): number {
			return e.l2Generation;
		},
	};
}

// L3 InvertedIndex handle。entry がなければ undefined (watcher 非稼働時は index 経由しない)。
// indexFile は capturedEpoch と現在世代を比較し、read 中に modify batch が来ていた場合
// (= currentEpochOf ≠ capturedEpoch) は無視する (piggyback / idle fill の race 対策、
// Phase B の capturedGen の姉妹)。
export function getInvertedIndexHandle(canonicalRoot: string): InvertedIndexHandle | undefined {
	const e = entries.get(canonicalRoot);
	if (e === undefined) return undefined;
	return {
		indexFile(ioPath: string, text: string, capturedEpoch: number): void {
			const current = entries.get(canonicalRoot);
			if (current !== e) return;
			if (e.l3.currentEpochOf(ioPath) !== capturedEpoch) return;
			e.l3.indexFile(ioPath, text);
		},
		currentEpochOf(ioPath: string): number {
			return e.l3.currentEpochOf(ioPath);
		},
		isIndexedAndValid(ioPath: string): boolean {
			return e.l3.isIndexedAndValid(ioPath);
		},
		getCandidates(queryLower: string): CandidateResult {
			return e.l3.getCandidates(queryLower);
		},
		verify(
			query: string,
			caseSensitive: boolean,
			allIoFiles: readonly string[],
			hitIoFiles: readonly string[],
		): void {
			verifyIndexSuperset(e.l3, query, caseSensitive, allIoFiles, hitIoFiles);
		},
		get isDisabled(): boolean {
			return e.l3.isDisabled;
		},
	};
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
