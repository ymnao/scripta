// main プロセスと renderer / preload で共有する structured error の型 + ワイヤ codec。
//
// 背景: Electron IPC は handler の reject 時に `error.message`（と stack）しか
// renderer へ運ばず、`error.code` / `error.kind` 等のカスタムプロパティは IPC を
// 越えると失われる。そこで構造化エラーを `message` 文字列に JSON エンコードして
// 運び（main: encodeIpcError）、preload で decode してプロパティへ復元する
// （preload: decodeIpcError）。renderer は復元後の `error.kind` で分岐するため、
// メッセージ文字列の正規表現パースは不要になる
// （旧バックエンド由来の設計と移行経緯は docs/adr/0008-structured-fs-error.md を参照）。

// 構造化エラーの種別（discriminated union の discriminant）。
// errno 系は Node の `NodeJS.ErrnoException.code` をそのまま種別に採用し、
// 意味的なファイル操作エラー・git / network エラーは独自種別を割り当てる。
export type ErrorKind =
	// errno（Node が投げる生の errno をそのまま分類）
	| "ENOENT"
	| "EACCES"
	| "EEXIST"
	| "EISDIR"
	| "ENOTDIR"
	| "ENOSPC"
	| "EROFS"
	| "EAGAIN"
	| "EBUSY"
	| "ENAMETOOLONG"
	| "ENOTEMPTY"
	| "EMFILE"
	// 意味的なファイル操作エラー（fs ハンドラが文脈付きで投げる）
	| "ALREADY_EXISTS"
	| "SOURCE_NOT_FOUND"
	| "TARGET_ALREADY_EXISTS"
	| "NOT_FOUND"
	| "INVALID_PATH"
	| "PATH_OUTSIDE_WORKSPACE"
	// git / network エラー（git stderr を main 側で分類）
	| "GIT_AUTH"
	| "GIT_CONFLICT"
	| "GIT_NOTHING_TO_COMMIT"
	| "GIT_NO_REMOTE_ACCESS"
	| "NETWORK"
	| "CONNECTION_REFUSED"
	| "TIMEOUT"
	// 分類不能
	| "UNKNOWN";

// IPC を越えて運ぶ構造化エラーの payload。
export interface StructuredErrorData {
	kind: ErrorKind;
	// 開発者向けの生メッセージ（errno detail / git stderr 等）。
	// UI 表示の日本語化は renderer 側 errors.ts が kind から導出する。
	message: string;
	// 原因コード（NodeJS.ErrnoException.code 等）。デバッグ用途。
	code?: string;
	// 関連パス（あれば）。
	path?: string;
}

// `error.message` に埋め込む sentinel。preload はこの文字列を `indexOf` で
// 探すため、Electron が "Error invoking remote method ..." の prefix を付けて
// message を wrap しても（= sentinel が先頭に来なくても）復元できる。
export const IPC_ERROR_SENTINEL = "SCRIPTA_STRUCTURED_ERR:";

// 構造化エラーを sentinel + JSON 文字列へエンコードする（main → IPC 境界）。
export function encodeIpcError(data: StructuredErrorData): string {
	return `${IPC_ERROR_SENTINEL}${JSON.stringify(data)}`;
}

// sentinel を含む message から payload を復元する（preload）。
// sentinel が無い / JSON が壊れている場合は null（= 非構造化エラー）。
export function decodeIpcError(message: string): StructuredErrorData | null {
	const idx = message.indexOf(IPC_ERROR_SENTINEL);
	if (idx === -1) return null;
	const json = message.slice(idx + IPC_ERROR_SENTINEL.length);
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null) return null;
		const p = parsed as Record<string, unknown>;
		if (typeof p.kind !== "string" || typeof p.message !== "string") return null;
		// optional フィールド（code / path）も型検証してから復元する。
		// 不正型（number 等）は drop し、kind / message は活かす。
		const data: StructuredErrorData = { kind: p.kind as ErrorKind, message: p.message };
		if (typeof p.code === "string") data.code = p.code;
		if (typeof p.path === "string") data.path = p.path;
		return data;
	} catch {
		return null;
	}
}

// 任意の値から ErrorKind を取り出す（preload が復元時に付与した `kind` を読む）。
// 構造化されていない値は undefined。
export function getErrorKind(error: unknown): ErrorKind | undefined {
	if (typeof error === "object" && error !== null) {
		const kind = (error as { kind?: unknown }).kind;
		if (typeof kind === "string") return kind as ErrorKind;
	}
	return undefined;
}
