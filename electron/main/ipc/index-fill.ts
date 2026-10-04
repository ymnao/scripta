// L3 InvertedIndex の idle fill scheduler (#394 Phase C Step 5)。
//
// searchFilesImpl 完了直後などから `kickIdleFill(deps)` で発火され、
// 未 indexed / stale な .md file を setImmediate ループで少しずつ read → indexFile する。
// kick は冪等 (同一 IdleFillState が走行中なら no-op、完了後の再 kick で再開)。
// 発火時点の cache entry が生きている間のみ動作する (isAlive が entry identity で判定し、
// entry が drop または別 entry に置き換わった時点で自動 bail)。
//
// search-cache.ts の module state に直接触らず、deps injection で疎結合にする
// (test 容易性の確保と、helper 側の独立テスト性を保つため — processMdFilesParallel の
// ContentCacheHandle / InvertedIndexHandle と同じ設計方針)。

import { isIndexableResolution } from "../utils/path-guard";

export interface IdleFillIndex {
	indexFile(path: string, text: string, capturedEpoch: number): void;
	currentEpochOf(path: string): number;
	isIndexedAndValid(path: string): boolean;
	readonly isSaturated: boolean;
}

export interface IdleFillDeps {
	/** 現在の .md file 全リスト (canonical io path)。populate 済みでなければ undefined を返す。 */
	listIoFiles(): readonly string[] | undefined;
	/**
	 * file を readFile する。失敗時は throw して呼び手が catch/skip する。
	 * 呼び手は `resolveAllowed` が返した **解決済み path** を渡す (#406 Finding 2)。
	 *
	 * **末端 symlink を拒否する実装 (`readFileUtf8NoFollow`) を注入すること** (#412)。
	 * これは index 取り込み専用 read で、認可 (`resolveAllowed`) から read までの間に末端
	 * component を symlink へ差し替えられる窓を open 時点で閉じるための契約。plain readFile を
	 * 注入するとその窓が再開する。型では強制できないため契約として明文化する
	 * (production の wiring は search.ts の kickIdleFill 呼び出し側)。
	 */
	readFile(ioPath: string): Promise<string>;
	/**
	 * kick 時点の cache entry がまだ生きているか。**entry identity で判定する** (#589 A2/A3、
	 * root キーの存在確認では足りない理由は search-cache.ts の InvertedIndexHandle.isAlive 参照)。
	 */
	isAlive(): boolean;
	/**
	 * CacheEntry に 1 個持たせ、entry drop で一緒に捨てる (reopen で継承しない)。
	 * 同じ entry の kick 間で skip 記録と running を共有するための置き場。
	 */
	state: IdleFillState;
	/**
	 * L3 handle。**kick 時点で 1 度取得したもの**を返す (毎 tick 再取得しない)。
	 * handle は entry-identity を内部で保持しているため、workspace close → 再 open で
	 * 新 entry に切り替わっても、旧 handle 経由の indexFile は identity check で no-op になる
	 * (旧 entry 時代に読んだ text が新 entry の index に混入する race を防ぐ)。
	 */
	index: IdleFillIndex;
	/** 1 tick 遅延を挿入する (デフォルト setImmediate、test では即座 resolve でよい)。 */
	yieldTick?(): Promise<void>;
	/**
	 * readFile 直前の realpath 再認可 (#394 Phase D / #399 Finding 2)。
	 * workspace 外 symlink を追跡する file を index に載せないためのゲート。
	 * 許可時は **解決済み path** を返し、呼び手はその path で readFile する
	 * (検査対象と読み取り対象を揃えて TOCTOU を閉じる、#406 Finding 2)。
	 * null 応答時は cutoff 超過と同じく skipUntilEpochChange に記録される。
	 * 戻り値が引数 `ioPath` と不一致の場合は workspace 内 symlink (alias) とみなし、
	 * null と同じく index 取り込みを skip する (#413 Finding 2)。
	 * 必須 field: fail-open 事故を避けるため optional にしない (test の fake deps は
	 * 解決済み path を返すことで境界通過を宣言する)。
	 */
	resolveAllowed(ioPath: string): Promise<string | null>;
}

export interface IdleFillState {
	running: boolean;
	skipUntilEpochChange: Map<string, number>;
}

// skip 記録を runFill の local ではなく state に置くのは、検索ごとの kick で毎回空から
// 始まると、cutoff 超過 (1MiB 超) の .md を毎検索フル read してしまうため (#589 A1)。
// running を root キーの module Set にせず entry 単位にするのは、旧 loop が await 中に
// reopen されると root キーでは新 entry の kick が no-op になり、旧 loop が bail した後の
// 次の検索まで新 entry の fill が始まらないため。
export function createIdleFillState(): IdleFillState {
	return { running: false, skipUntilEpochChange: new Map<string, number>() };
}

const TICK_SIZE = 4;

// 冪等: 同一 state が走行中なら no-op。呼び手は search.ts の searchFilesImpl 完了直後などから呼ぶ。
export function kickIdleFill(deps: IdleFillDeps): void {
	if (deps.state.running) return;
	deps.state.running = true;
	void runFill(deps);
}

async function runFill(deps: IdleFillDeps): Promise<void> {
	// index.indexFile を試みても valid にならなかった file を skip する記録。
	// kick を跨いで保持する (deps.state 経由、entry drop まで生存)。
	// key = ioPath、value = skip 時の captured epoch。fileEpoch が動いていれば retry する
	// (cutoff 超過 → file が縮小されて再度 admission 通過するケースを retry で回収)。
	// この skip 記録がないと、恒常的な read エラー / cutoff 超過 file を無限に retry して
	// setImmediate 全速で CPU / IO を焼く無限ループになる。
	const skipUntilEpochChange = deps.state.skipUntilEpochChange;
	// 前回 tick の再開カーソル。N file の full fill で毎 tick 先頭から線形走査すると
	// O(N² / TICK_SIZE) になるため、位置を保持して次 tick は続きから舐める。
	// listIoFiles の並びが安定しない場合 (invalidation / file 追加) は cursor を 0 に戻す
	// (skipUntilEpochChange 側で無限 revisit は防がれる)。
	let cursor = 0;
	let prevListLength = -1;
	try {
		while (deps.isAlive()) {
			if (deps.index.isSaturated) break;
			const files = deps.listIoFiles();
			if (files === undefined) break;
			if (files.length !== prevListLength) {
				cursor = 0;
				prevListLength = files.length;
			}

			let picked = 0;
			let visited = 0;
			// files は resume cursor から始めて 1 周する。全 file を舐めて picked=0 なら完了 bail。
			const start = cursor;
			while (visited < files.length && picked < TICK_SIZE) {
				const idx = (start + visited) % files.length;
				visited++;
				const p = files[idx];
				if (deps.index.isIndexedAndValid(p)) continue;
				const current = deps.index.currentEpochOf(p);
				const skipped = skipUntilEpochChange.get(p);
				if (skipped !== undefined && skipped === current) continue;
				try {
					// realpath 再認可 (#394 Phase D / #399 Finding 2) を readFile より **先** に
					// 走らせる: workspace 外を指す symlink file の全文読み込みコストを避ける。
					// null / 失敗時は cutoff 超過と同じ経路 (skipUntilEpochChange 記録) に倒す —
					// fileEpoch が動けば自動 retry される。
					// readFile には **解決済み path** を渡す (#406 Finding 2、契約は resolveInsideRoot の
					// doc 参照)。index の key は従来どおり `p` (workspace 内の path)。
					const resolved = await deps.resolveAllowed(p).catch(() => null);
					if (!deps.isAlive()) break;
					if (deps.index.isSaturated) break;
					// resolved !== p は workspace 内 symlink (alias)。index の key は p 側に付くが
					// watcher (followSymlinks: false) の modify は解決先の path でしか来ないため
					// invalidate が波及せず stale posting が残る。reject と同じ経路に倒して
					// 未 index のままにする (#413 Finding 2、search.ts の piggyback 側と同じ述語)。
					// p 自身の epoch が動くまで再訪しない = alias である限り恒久 skip だが、
					// link が実体 file に差し替われば watcher が p の event を出して epoch が動く。
					if (!isIndexableResolution(resolved, p)) {
						skipUntilEpochChange.set(p, current);
					} else {
						// ここに来た時点で resolved === p (isIndexableResolution の契約) なので、
						// #406 の「検査した実体を読む」は p を読むことと同値。narrowing に頼らず
						// p を渡す (述語は boolean 返しで、false 側の型が正確に表せないため)。
						const text = await deps.readFile(p);
						if (!deps.isAlive()) break;
						if (deps.index.isSaturated) break;
						deps.index.indexFile(p, text, current);
						// indexFile が noop (identity check / capturedEpoch 不一致 / cutoff reject 等) で
						// valid にならなかったら skip 記録して次回の epoch 変化まで retry しない。
						if (!deps.index.isIndexedAndValid(p)) {
							skipUntilEpochChange.set(p, current);
						} else {
							skipUntilEpochChange.delete(p);
						}
					}
				} catch {
					// 読み取り失敗は skip 記録する (存在しない file / 権限エラー等の無限リトライ回避)。
					// errno は区別しないので、一時的な失敗 (lock / EMFILE 等) も epoch が動くか reopen まで
					// idle fill では retry しない。未 index file は検索の scan 対象に残り piggyback が
					// 拾うので、失うのは最適化だけで結果の正しさは変わらない。
					skipUntilEpochChange.set(p, current);
				}
				picked++;
				cursor = (idx + 1) % files.length;
			}
			if (picked === 0) break; // 全 valid or 全 skip 済み = 消化完了
			const y = deps.yieldTick ?? defaultYield;
			await y();
		}
	} finally {
		deps.state.running = false;
	}
}

function defaultYield(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}
