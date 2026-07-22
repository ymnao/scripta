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

export interface IdleFillDeps {
	/** 現在の .md file 全リスト (canonical io path)。populate 済みでなければ undefined を返す。 */
	listIoFiles(): readonly string[] | undefined;
	/** file を readFile する。失敗時は throw して呼び手が catch/skip する。 */
	readFile(ioPath: string): Promise<string>;
	/** entry がまだ生きているか (refCount > 0 で map に残っているか)。 */
	isAlive(): boolean;
	/** L3 handle。undefined 時は fill しない (entry drop 済み)。 */
	getIndex():
		| {
				indexFile(path: string, text: string, capturedEpoch: number): void;
				currentEpochOf(path: string): number;
				isIndexedAndValid(path: string): boolean;
				readonly isDisabled: boolean;
		  }
		| undefined;
	/** 1 tick 遅延を挿入する (デフォルト setImmediate、test では即座 resolve でよい)。 */
	yieldTick?(): Promise<void>;
}

interface IdleFillState {
	running: boolean;
}

const states = new Map<string, IdleFillState>();

const TICK_SIZE = 4;

// 冪等: 走行中なら no-op。呼び手は search.ts の searchFilesImpl 完了直後などから呼ぶ。
export function kickIdleFill(canonicalRoot: string, deps: IdleFillDeps): void {
	const existing = states.get(canonicalRoot);
	if (existing !== undefined && existing.running) return;
	const state: IdleFillState = { running: true };
	states.set(canonicalRoot, state);
	void runFill(canonicalRoot, deps, state);
}

async function runFill(
	_canonicalRoot: string,
	deps: IdleFillDeps,
	state: IdleFillState,
): Promise<void> {
	try {
		while (deps.isAlive()) {
			// entry drop / disabled 化を tick ごとに検知するため毎 tick で呼ぶ。
			const index = deps.getIndex();
			if (index === undefined || index.isDisabled) break;
			const files = deps.listIoFiles();
			if (files === undefined) break;
			// 未 indexed または stale な file を優先的にピック (現状 valid は skip)。
			let picked = 0;
			for (const p of files) {
				if (picked >= TICK_SIZE) break;
				if (index.isIndexedAndValid(p)) continue;
				// read 前に epoch snapshot。
				const captured = index.currentEpochOf(p);
				try {
					const text = await deps.readFile(p);
					// read 完了後の再チェック (entry drop / disabled 化を検知)。
					if (!deps.isAlive()) break;
					const idx2 = deps.getIndex();
					if (idx2 === undefined || idx2.isDisabled) break;
					idx2.indexFile(p, text, captured);
				} catch {
					// 読み取り失敗は skip して次へ。
				}
				picked++;
			}
			if (picked === 0) break; // 全 valid = 消化完了
			// 次 tick へ yield。
			const y = deps.yieldTick ?? defaultYield;
			await y();
		}
	} finally {
		state.running = false;
	}
}

function defaultYield(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

// test 用: 全 idle fill state をリセットする。production コードから呼んではならない。
export function _cancelAllIdleFillForTest(): void {
	states.clear();
}

// test 用: 現在 running 中かどうかを返す。
export function _isRunningForTest(canonicalRoot: string): boolean {
	return states.get(canonicalRoot)?.running === true;
}
