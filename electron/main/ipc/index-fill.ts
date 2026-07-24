// L3 InvertedIndex の idle fill scheduler (#394 Phase C Step 5)。
//
// searchFilesImpl 完了直後などから `kickIdleFill(canonicalRoot)` で発火され、
// 未 indexed / stale な .md file を setImmediate ループで少しずつ read → indexFile する。
// kick は冪等 (走行中なら no-op、完了後の再 kick で再開)。
// workspace 生存中のみ動作する (entry が Map から drop された時点で自動 bail)。
//
// search-cache.ts の module state に直接触らず、deps injection で疎結合にする
// (test 容易性の確保と、helper 側の独立テスト性を保つため — processMdFilesParallel の
// ContentCacheHandle / InvertedIndexHandle と同じ設計方針)。

export interface IdleFillIndex {
	indexFile(path: string, text: string, capturedEpoch: number): void;
	currentEpochOf(path: string): number;
	isIndexedAndValid(path: string): boolean;
	readonly isDisabled: boolean;
}

export interface IdleFillDeps {
	/** 現在の .md file 全リスト (canonical io path)。populate 済みでなければ undefined を返す。 */
	listIoFiles(): readonly string[] | undefined;
	/** file を readFile する。失敗時は throw して呼び手が catch/skip する。 */
	readFile(ioPath: string): Promise<string>;
	/** entry がまだ生きているか (refCount > 0 で map に残っているか)。 */
	isAlive(): boolean;
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
	 * false 応答時は cutoff 超過と同じく skipUntilEpochChange に記録される。
	 * 必須 field: fail-open 事故を避けるため optional にしない (test の fake deps は
	 * `async () => true` を明示することで境界通過を宣言する)。
	 */
	isRealPathAllowed(ioPath: string): Promise<boolean>;
}

// 「走行中の canonicalRoot 集合」を保持する。field 1 個だけの wrapper を持つより素直。
const running = new Set<string>();

const TICK_SIZE = 4;

// 冪等: 走行中なら no-op。呼び手は search.ts の searchFilesImpl 完了直後などから呼ぶ。
export function kickIdleFill(canonicalRoot: string, deps: IdleFillDeps): void {
	if (running.has(canonicalRoot)) return;
	running.add(canonicalRoot);
	void runFill(canonicalRoot, deps);
}

async function runFill(canonicalRoot: string, deps: IdleFillDeps): Promise<void> {
	// index.indexFile を試みても valid にならなかった file を skip する記録。
	// key = ioPath、value = skip 時の captured epoch。fileEpoch が動いていれば retry する
	// (cutoff 超過 → file が縮小されて再度 admission 通過するケースを retry で回収)。
	// この skip 記録がないと、恒常的な read エラー / cutoff 超過 file を無限に retry して
	// setImmediate 全速で CPU / IO を焼く無限ループになる。
	const skipUntilEpochChange = new Map<string, number>();
	// 前回 tick の再開カーソル。N file の full fill で毎 tick 先頭から線形走査すると
	// O(N² / TICK_SIZE) になるため、位置を保持して次 tick は続きから舐める。
	// listIoFiles の並びが安定しない場合 (invalidation / file 追加) は cursor を 0 に戻す
	// (skipUntilEpochChange 側で無限 revisit は防がれる)。
	let cursor = 0;
	let prevListLength = -1;
	try {
		while (deps.isAlive()) {
			if (deps.index.isDisabled) break;
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
					// false / 失敗時は cutoff 超過と同じ経路 (skipUntilEpochChange 記録) に倒す —
					// fileEpoch が動けば自動 retry される。
					const allowed = await deps.isRealPathAllowed(p).catch(() => false);
					if (!deps.isAlive()) break;
					if (deps.index.isDisabled) break;
					if (!allowed) {
						skipUntilEpochChange.set(p, current);
					} else {
						const text = await deps.readFile(p);
						if (!deps.isAlive()) break;
						if (deps.index.isDisabled) break;
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
		running.delete(canonicalRoot);
	}
}

function defaultYield(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

// test 用: 全 idle fill state をリセットする。production コードから呼んではならない。
export function _cancelAllIdleFillForTest(): void {
	running.clear();
}

// test 用: 現在 running 中かどうかを返す。
export function _isRunningForTest(canonicalRoot: string): boolean {
	return running.has(canonicalRoot);
}
