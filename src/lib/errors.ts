import { type ErrorKind, getErrorKind } from "../types/errors";

// main から IPC 越しに渡る構造化エラー（preload で unmarshal 済み、`error.kind` を持つ）を
// renderer で扱うためのユーティリティ。
//
// 旧実装はエラーの message 文字列を正規表現でパースして種別判定していたが、現在は
// main 側で 1 度だけ分類した `error.kind`（discriminated union）で分岐する。
// 種別ごとの分類ロジックは `electron/main/utils/structured-error.ts` に存在する
// （設計判断の経緯は docs/adr/0008-structured-fs-error.md を参照）。

function extractMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	return String(error);
}

// ErrorKind → ユーザー向け日本語メッセージ。UNKNOWN は raw detail を併記するため別扱い。
const KIND_MESSAGES: Record<Exclude<ErrorKind, "UNKNOWN">, string> = {
	// errno
	ENOENT: "ファイルまたはフォルダが見つかりません",
	EACCES: "アクセス権限がありません",
	EEXIST: "ファイルが既に存在します",
	EISDIR: "対象がディレクトリです",
	ENOTDIR: "対象がディレクトリではありません",
	ENOSPC: "ディスク容量が不足しています",
	EROFS: "読み取り専用のファイルシステムです",
	EAGAIN: "リソースが一時的に利用できません",
	EBUSY: "ファイルが使用中です",
	ENAMETOOLONG: "ファイル名が長すぎます",
	ENOTEMPTY: "フォルダが空ではありません",
	EMFILE: "開いているファイルが多すぎます",
	// 意味的なファイル操作エラー
	ALREADY_EXISTS: "同名のファイルが既に存在します",
	SOURCE_NOT_FOUND: "元のファイルが見つかりません",
	TARGET_ALREADY_EXISTS: "移動先に同名のファイルが既に存在します",
	NOT_FOUND: "ファイルが見つかりません",
	INVALID_PATH: "不正なパスです",
	PATH_OUTSIDE_WORKSPACE: "アクセス権限がありません",
	// git / network
	GIT_AUTH: "Git 認証に失敗しました",
	GIT_CONFLICT: "マージコンフリクトが発生しました",
	GIT_NOTHING_TO_COMMIT: "コミットする変更がありません",
	GIT_NO_REMOTE_ACCESS: "リモートリポジトリにアクセスできません",
	NETWORK: "ネットワークに接続できません",
	CONNECTION_REFUSED: "接続が拒否されました",
	TIMEOUT: "操作がタイムアウトしました",
};

export function translateError(error: unknown): string {
	const kind = getErrorKind(error);
	if (kind !== undefined && kind !== "UNKNOWN") {
		return KIND_MESSAGES[kind];
	}
	return `予期しないエラーが発生しました。詳細: ${extractMessage(error)}`;
}

// withRetry の対象外（再試行しても回復しない）種別。これら以外（EAGAIN/EBUSY 等の
// 一時的エラー・kind 不明・UNKNOWN）は transient 扱いで再試行する。
const NON_TRANSIENT_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
	"ALREADY_EXISTS",
	"SOURCE_NOT_FOUND",
	"TARGET_ALREADY_EXISTS",
	"NOT_FOUND",
	"ENOENT",
	"EACCES",
	"EEXIST",
	"EISDIR",
	"ENOTDIR",
	"ENOSPC",
	"EROFS",
	"ENAMETOOLONG",
	"ENOTEMPTY",
	// FD 枯渇は短時間の再試行で回復しないことが多く、無駄な再試行を避ける
	"EMFILE",
	"INVALID_PATH",
	"PATH_OUTSIDE_WORKSPACE",
]);

export function isTransientError(error: unknown): boolean {
	const kind = getErrorKind(error);
	if (kind === undefined) return true;
	return !NON_TRANSIENT_KINDS.has(kind);
}

// git offline mode 判定に使う、ネットワーク起因の種別。
// 認証失敗（GIT_AUTH）や 401/403（GIT_NO_REMOTE_ACCESS）は network ではないため除外する。
const NETWORK_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
	"NETWORK",
	"CONNECTION_REFUSED",
	"TIMEOUT",
]);

export function isNetworkError(error: unknown): boolean {
	const kind = getErrorKind(error);
	return kind !== undefined && NETWORK_KINDS.has(kind);
}
