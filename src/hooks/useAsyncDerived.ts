import { useEffect, useState } from "react";

/**
 * 「同期即返し → 非同期完了で上書き」パターンの汎用フック。
 *
 * `deps` が変わるたびに `asyncFn()` を再起動し、完了時の deps が呼び出し側の
 * 現 render の deps と識別子一致する場合のみ結果を採用する (stale ガード)。
 * `deps` は React の useEffect と同じ順序で識別子比較される (`===`)。
 * `asyncFn` が reject した場合は初期値 (`initial`) にフォールバックする。
 */
export function useAsyncDerived<Output>(
	deps: readonly unknown[],
	initial: Output,
	asyncFn: () => Promise<Output>,
): Output {
	const [async_, setAsync] = useState<{
		value: Output;
		deps: readonly unknown[];
	} | null>(null);
	useEffect(() => {
		let cancelled = false;
		asyncFn()
			.then((value) => {
				if (!cancelled) setAsync({ value, deps });
			})
			.catch(() => {
				// 非同期失敗時は initial にフォールバック
			});
		return () => {
			cancelled = true;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: deps は呼び出し側が明示的に管理する
	}, deps);
	return async_ && depsEqual(async_.deps, deps) ? async_.value : initial;
}

function depsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
