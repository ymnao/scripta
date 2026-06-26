interface ScanStateBase {
	_scanId: number;
	loading: boolean;
}

interface CreateScanActionOptions<TState extends ScanStateBase, TArgs extends unknown[], TResult> {
	/**
	 * scan 実行時に毎回呼ばれる thunk。中で実 API 関数を返す。
	 *
	 * thunk にしているのは store 評価時に `commands` からシンボルを直接読み出すと、
	 * 関係ない hooks/components のテストが `vi.mock("../lib/commands", () => ({ ... }))` で
	 * 一部の export しか mock していない場合に strict-mock エラーが出るのを避けるため。
	 * thunk 内の `commands` への参照は ES module の live binding で scan 呼び出し時に解決される。
	 */
	api: () => (...args: TArgs) => Promise<TResult>;
	// `_scanId` / `loading` は factory が排他的に管理する。consumer が誤って戻り値に含めても
	// silently 上書きされて気付けないので、戻り型から除外して compile error にする。
	applyResult: (result: TResult) => Omit<Partial<TState>, "_scanId" | "loading">;
	errorMessage: string;
	beforeScan?: (state: TState, args: TArgs) => Omit<Partial<TState>, "_scanId" | "loading">;
}

// zustand の `StoreApi['setState']` overload は `replace: true` で full state を要求する
// パスがあり、TS が generic 内で narrowing しきれないため、本 factory が必要な分だけ
// narrower な local 型に絞っている (callsite は zustand の set/get と互換)。
type SetState<TState> = (partial: Partial<TState>) => void;
type GetState<TState> = () => TState;

/**
 * stale な非同期スキャンを `_scanId` の単調増加で破棄する共通 factory。
 * scan 中に同じ store に対する次の scan が走ったら、古い結果は state に書き戻さない。
 */
export function createScanAction<TState extends ScanStateBase, TArgs extends unknown[], TResult>(
	opts: CreateScanActionOptions<TState, TArgs, TResult>,
) {
	return (set: SetState<TState>, get: GetState<TState>) =>
		async (...args: TArgs) => {
			const scanId = get()._scanId + 1;
			const before = opts.beforeScan?.(get(), args) ?? {};
			set({ ...before, loading: true, _scanId: scanId } as Partial<TState>);
			try {
				const result = await opts.api()(...args);
				if (get()._scanId !== scanId) return;
				set({ ...opts.applyResult(result), loading: false } as Partial<TState>);
			} catch (error) {
				if (get()._scanId !== scanId) return;
				console.error(opts.errorMessage, error);
				set({ loading: false } as Partial<TState>);
			}
		};
}
