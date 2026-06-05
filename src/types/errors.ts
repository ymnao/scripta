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
	// ユーザ操作（文書切替 / unmount 等）由来の cancel。renderer は cache を error
	// 状態にせず削除して次回 retry を許可する。
	| "ABORTED"
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

// sentinel 直後の文字列から、最初の完結した JSON オブジェクト（`{...}`）だけを
// 取り出す。文字列リテラル内の `{` / `}` とエスケープを考慮した brace 走査なので、
// message 値に波括弧が含まれても誤検出しない。見つからなければ null。
function extractFirstJsonObject(s: string): string | null {
	const start = s.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString && ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}

// sentinel 以降の文字列を構造化 payload としてパースする。
// 1. fast path: そのまま JSON.parse（従来挙動。正常系はゼロ回帰）。
// 2. fallback: parse に失敗したら、末尾混入（stack 等）を想定して最初の完結
//    JSON オブジェクトだけを切り出して再 parse する。
// どちらも失敗したら undefined。
function parseStructuredPayload(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		// 末尾に余分な文字列（IPC レイヤが連結した stack 等）が付くと JSON.parse は
		// throw する。JSON 本体だけを抽出して再試行する。
	}
	const obj = extractFirstJsonObject(json);
	if (obj === null) return undefined;
	try {
		return JSON.parse(obj);
	} catch {
		return undefined;
	}
}

// sentinel を含む message から payload を復元する（preload）。
// sentinel が無い / JSON が壊れている場合は null（= 非構造化エラー）。
//
// JSON 本体の取り出しは parseStructuredPayload に委譲する。Electron 42 以降の
// invoke reject は message の末尾に error stack を連結してくることがあり、その
// 場合 sentinel 以降を末尾まで JSON.parse すると "Unexpected non-whitespace
// character after JSON" で失敗する。fast path + brace 走査の fallback で吸収する。
export function decodeIpcError(message: string): StructuredErrorData | null {
	const idx = message.indexOf(IPC_ERROR_SENTINEL);
	if (idx === -1) return null;
	const json = message.slice(idx + IPC_ERROR_SENTINEL.length);
	const parsed = parseStructuredPayload(json);
	if (typeof parsed !== "object" || parsed === null) return null;
	const p = parsed as Record<string, unknown>;
	// IPC 境界の decoder なので own property のみを信頼する（`{"__proto__":{...}}`
	// 等の prototype 経由の値で復元されないよう Object.hasOwn で限定）。
	if (
		!Object.hasOwn(p, "kind") ||
		!Object.hasOwn(p, "message") ||
		typeof p.kind !== "string" ||
		typeof p.message !== "string"
	) {
		return null;
	}
	// optional フィールド（code / path）も own かつ string のときのみ復元する。
	const data: StructuredErrorData = { kind: p.kind as ErrorKind, message: p.message };
	if (Object.hasOwn(p, "code") && typeof p.code === "string") data.code = p.code;
	if (Object.hasOwn(p, "path") && typeof p.path === "string") data.path = p.path;
	return data;
}

// 任意の値から ErrorKind を取り出す（preload が復元時に付与した `kind` を読む）。
// 構造化されていない値は undefined。
export function getErrorKind(error: unknown): ErrorKind | undefined {
	// preload が付与する own property `kind` のみを読む（prototype 汚染で誤判定しない）。
	if (typeof error === "object" && error !== null && Object.hasOwn(error, "kind")) {
		const kind = (error as { kind?: unknown }).kind;
		if (typeof kind === "string") return kind as ErrorKind;
	}
	return undefined;
}
