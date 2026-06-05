import { decodeIpcError, encodeIpcError } from "../../src/types/errors";

// preload で IPC reject を正規化するための層。
//
// main 側 `handle()` は構造化エラーを `encodeIpcError`（sentinel + JSON）で
// `error.message` に埋めて IPC を越えさせる。Electron は invoke の reject 時に
// message を "Error invoking remote method '<channel>': ..." で wrap し、さらに
// 末尾へ stack を連結することがあるが、decodeIpcError は sentinel を `indexOf` で
// 探し JSON 本体だけを抽出するため、prefix / 末尾混入に影響されない。
//
// ⚠️ contextBridge は Error の `message` / `stack` のみを renderer（main world）へ
// 渡し、`kind` / `code` / `path` のようなカスタムプロパティは剥がす。そこで preload
// では「decode して clean Error を作る」のではなく、**正規化した sentinel payload を
// 改めて `message` に載せ直して** renderer へ運ぶ。renderer 側 `getErrorKind` /
// `getStructuredMessage` がその message から kind / 表示メッセージを復元する。
// （旧実装は `error.kind` を付与していたが、bridge を越えると失われていた。）

// IPC reject の生エラーを、構造化されていれば「clean な sentinel を message に持つ
// Error」へ正規化する。構造化されていない（sentinel が無い）場合は元のエラーをそのまま
// 返す。
export function rebuildIpcError(raw: unknown): unknown {
	const message = raw instanceof Error ? raw.message : String(raw);
	const data = decodeIpcError(message);
	if (data === null) return raw;
	// Electron の prefix wrap / 末尾 stack を落として 1 行の sentinel に正規化する。
	// kind / code / path は payload（message）に含まれるため bridge を越えても保持される。
	return new Error(encodeIpcError(data));
}

// ipcRenderer.invoke の戻り Promise をラップし、reject を正規化された構造化 Error に変換する。
export function invokeWithStructuredError<T>(invocation: Promise<T>): Promise<T> {
	return invocation.catch((err: unknown) => {
		throw rebuildIpcError(err);
	});
}
