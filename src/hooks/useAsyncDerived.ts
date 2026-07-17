import { useEffect, useState } from "react";
import { isAbortError } from "../lib/abort";

/**
 * 「初回は同期の initial を返し、非同期完了後は前回の成功値を保持しつつ次の
 * 完了で上書きする」パターンの汎用フック。
 *
 * `deps` が変わるたびに `asyncFn(signal)` を再起動する。前回起動時の `AbortSignal`
 * を cleanup で abort するので、`asyncFn` は signal を協調的に検査すれば処理を
 * 早期終了できる (deps 連打時の CPU waste 軽減)。deps が変わっても直前の
 * async 成功値を保持し続けるため、theme 切替や rapid typing 時に initial
 * (mermaid が fenced code のままなど「不完全な状態」) へ一瞬戻す flash を防ぐ。
 * 初回描画 (まだどの async も成功していない状態) では initial を返す。
 *
 * `asyncFn` が reject した場合は `console.error` に記録し、既存の async 値を
 * そのまま保持する (silent 化しない)。ただし cleanup で abort されて中断された
 * 場合 (signal.aborted / AbortError) は「意図的キャンセル」として log しない。
 */
export function useAsyncDerived<Output>(
	deps: readonly unknown[],
	initial: Output,
	asyncFn: (signal: AbortSignal) => Promise<Output>,
): Output {
	const [async_, setAsync] = useState<{ value: Output } | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		asyncFn(controller.signal)
			.then((value) => {
				if (!controller.signal.aborted) setAsync({ value });
			})
			.catch((err) => {
				if (controller.signal.aborted) return;
				// AbortError は「共有 promise が別 effect の abort で reject した」ケース
				// (useSlideHtmls の per-slide cache 経由)。設計上のキャンセルなので log しない。
				if (isAbortError(err)) return;
				// silent 化禁止 (mermaid-preprocess.ts #106 と同ポリシー)。
				console.error("[useAsyncDerived] async failed:", err);
			});
		return () => {
			controller.abort();
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: deps は呼び出し側が明示的に管理する
	}, deps);
	return async_ ? async_.value : initial;
}
