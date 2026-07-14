import { useEffect, useState } from "react";

/**
 * 「初回は同期の initial を返し、非同期完了後は前回の成功値を保持しつつ次の
 * 完了で上書きする」パターンの汎用フック。
 *
 * `deps` が変わるたびに `asyncFn()` を再起動する。deps が変わっても直前の
 * async 成功値を保持し続けるため、theme 切替や rapid typing 時に initial
 * (mermaid が fenced code のままなど「不完全な状態」) へ一瞬戻す flash を防ぐ。
 * 初回描画 (まだどの async も成功していない状態) では initial を返す。
 *
 * `asyncFn` が reject した場合は `console.error` に記録し、既存の async 値を
 * そのまま保持する (silent 化しない)。
 */
export function useAsyncDerived<Output>(
	deps: readonly unknown[],
	initial: Output,
	asyncFn: () => Promise<Output>,
): Output {
	const [async_, setAsync] = useState<{ value: Output } | null>(null);
	useEffect(() => {
		let cancelled = false;
		asyncFn()
			.then((value) => {
				if (!cancelled) setAsync({ value });
			})
			.catch((err) => {
				if (!cancelled) {
					// silent 化禁止 (mermaid-preprocess.ts #106 と同ポリシー)。
					console.error("[useAsyncDerived] async failed:", err);
				}
			});
		return () => {
			cancelled = true;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: deps は呼び出し側が明示的に管理する
	}, deps);
	return async_ ? async_.value : initial;
}
