import { decodeIpcError, type ErrorKind } from "../../src/types/errors";

// preload で IPC reject を unmarshal するための層。
//
// main 側 `handle()` は構造化エラーを `encodeIpcError`（sentinel + JSON）で
// `error.message` に埋めて IPC を越えさせる。Electron は invoke の reject 時に
// message を "Error invoking remote method '<channel>': ..." の形で wrap しうるが、
// decodeIpcError は sentinel を `indexOf` で探すため prefix wrap に影響されない。
//
// 復元後は `kind` / `code` / `path` を持つ Error を renderer へ投げ、renderer 側
// errors.ts は `error.kind` で分岐する（メッセージ文字列の正規表現パースは不要）。

// renderer が参照する、構造化された Error の形状。
export interface DecodedIpcError extends Error {
	kind: ErrorKind;
	code?: string;
	path?: string;
}

// IPC reject の生エラーを、構造化されていれば kind 付き Error へ復元する。
// 構造化されていない（sentinel が無い）場合は元のエラーをそのまま返す。
export function rebuildIpcError(raw: unknown): unknown {
	const message = raw instanceof Error ? raw.message : String(raw);
	const data = decodeIpcError(message);
	if (data === null) return raw;
	const err = new Error(data.message) as DecodedIpcError;
	err.kind = data.kind;
	if (data.code !== undefined) err.code = data.code;
	if (data.path !== undefined) err.path = data.path;
	return err;
}

// ipcRenderer.invoke の戻り Promise をラップし、reject を構造化 Error に変換する。
export function invokeWithStructuredError<T>(invocation: Promise<T>): Promise<T> {
	return invocation.catch((err: unknown) => {
		throw rebuildIpcError(err);
	});
}
