/**
 * 協調的キャンセルの共通ユーティリティ。renderer 側の複数モジュール
 * (`mermaid.ts` / `mermaid-preprocess.ts` / `useAsyncDerived.ts` 等) が
 * DOMException("Aborted", "AbortError") のインスタンス生成 / 判定を同形で行うため
 * ここに集約する (電 main プロセスの `http-fetch.ts` は別バンドル・別 semantics)。
 */

export function abortError(): DOMException {
	return new DOMException("Aborted", "AbortError");
}

export function isAbortError(err: unknown): boolean {
	return err instanceof DOMException && err.name === "AbortError";
}
