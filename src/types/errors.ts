// main プロセスと renderer / preload で共有する structured error の型 + ワイヤ codec。
//
// 背景: Electron IPC / contextBridge は error の `message`（と stack）しか renderer へ
// 運ばず、`error.code` / `error.kind` 等のカスタムプロパティは境界を越えると失われる
// （ipcRenderer.invoke の reject も、preload→renderer の contextBridge も同様）。
// そこで構造化エラーを `message` 文字列に JSON エンコードして運ぶ（main: encodeIpcError）。
//
// preload（ipc-error-decode）は Electron の prefix wrap / 末尾 stack を decode→再 encode で
// 正規化し、**clean な sentinel payload を再び message に載せて** renderer へ渡す
// （`error.kind` プロパティを付けても contextBridge で剥がれるため、kind は message 経由で運ぶ）。
// renderer は `getErrorKind` / `getStructuredMessage` で message から kind / 表示メッセージを
// 復元して分岐する（メッセージ文字列の正規表現パースは不要）。
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
//
// 先頭は `JSON.parse` と整合的に whitespace のみ許容し、最初の非 whitespace は `{`
// を要求する。これにより sentinel 直後に任意の garbage がある payload
// （例: `SCRIPTA_STRUCTURED_ERR:not-json{"kind":"NETWORK"}`）を decoder の trust
// 境界として弾く。本 fallback の目的は「valid な sentinel + JSON の末尾に Electron
// の stack が連結したケース」だけを救うこと。
function extractFirstJsonObject(s: string): string | null {
	let start = 0;
	while (start < s.length) {
		const ch = s[start];
		if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
		start++;
	}
	if (s[start] !== "{") return null;
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

// 任意の値から ErrorKind を取り出す。
// 1. own property `kind`（テスト / mock が直接付与するケース。prototype 汚染は無視）
// 2. それが無ければ `error.message` に埋まった sentinel payload から decode する
//    （実 IPC 経路: contextBridge が `kind` プロパティを剥がすため、kind は preload が
//    message へ載せ直した sentinel 経由でしか renderer に届かない）。
// どちらも該当しなければ undefined。
export function getErrorKind(error: unknown): ErrorKind | undefined {
	if (typeof error === "object" && error !== null && Object.hasOwn(error, "kind")) {
		const kind = (error as { kind?: unknown }).kind;
		if (typeof kind === "string") return kind as ErrorKind;
	}
	const message = getRawErrorMessage(error);
	if (message !== undefined) {
		const decoded = decodeIpcError(message);
		if (decoded !== null) return decoded.kind;
	}
	return undefined;
}

// Error / 文字列から生の message 文字列を取り出す（内部ヘルパ）。
function getRawErrorMessage(error: unknown): string | undefined {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null && Object.hasOwn(error, "message")) {
		const m = (error as { message?: unknown }).message;
		if (typeof m === "string") return m;
	}
	return undefined;
}

// `error.message` に sentinel payload が埋まっていれば、その「素のメッセージ」
// （main 側が保持した errno detail / git stderr 等）を取り出す。埋まっていなければ
// 元の message をそのまま返す。表示や message テキスト判定はこれを通すこと
// （実 IPC 経路では message が sentinel-encoded になっているため）。
export function getStructuredMessage(error: unknown): string {
	const message = getRawErrorMessage(error);
	if (message === undefined) return String(error);
	const decoded = decodeIpcError(message);
	return decoded !== null ? decoded.message : message;
}
