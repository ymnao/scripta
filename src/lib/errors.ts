function extractMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	return String(error);
}

interface ErrorPattern {
	test: RegExp;
	message: string;
}

const PATTERNS: ErrorPattern[] = [
	{ test: /^Already exists:/, message: "同名のファイルが既に存在します" },
	{ test: /^Source not found:/, message: "元のファイルが見つかりません" },
	{ test: /^Target already exists:/, message: "移動先に同名のファイルが既に存在します" },
	{ test: /^Not found:/, message: "ファイルが見つかりません" },
	{ test: /\(os error 2\)/, message: "ファイルまたはフォルダが見つかりません" },
	{ test: /\(os error 13\)/, message: "アクセス権限がありません" },
	{ test: /\(os error 17\)/, message: "ファイルが既に存在します" },
	{ test: /\(os error 28\)/, message: "ディスク容量が不足しています" },
	{ test: /\(os error 30\)/, message: "読み取り専用のファイルシステムです" },
	{ test: /authentication failed/i, message: "Git 認証に失敗しました" },
	{ test: /could not resolve host/i, message: "ネットワークに接続できません" },
	{ test: /unable to access/i, message: "リモートリポジトリにアクセスできません" },
	{ test: /conflict/i, message: "マージコンフリクトが発生しました" },
	{ test: /nothing to commit/i, message: "コミットする変更がありません" },
	{ test: /\(os error 11\)/, message: "リソースが一時的に利用できません" },
	{ test: /\(os error 16\)/, message: "ファイルが使用中です" },
	{ test: /\(os error 35\)/, message: "リソースが一時的に利用できません" },
	{ test: /\(os error 36\)/, message: "操作の進行中です" },
	{ test: /\(os error 63\)/, message: "ファイル名が長すぎます" },
	{ test: /\(os error 66\)/, message: "フォルダが空ではありません" },
	{ test: /timed?\s*out/i, message: "操作がタイムアウトしました" },
	{ test: /too many open files/i, message: "開いているファイルが多すぎます" },
	{ test: /connection refused/i, message: "接続が拒否されました" },
	{ test: /network is unreachable/i, message: "ネットワークに接続できません" },
];

export function translateError(error: unknown): string {
	const raw = extractMessage(error);
	for (const { test, message } of PATTERNS) {
		if (test.test(raw)) return message;
	}
	return `予期しないエラーが発生しました。詳細: ${raw}`;
}

// Non-transient patterns for file I/O retry logic (withRetry).
// Only includes file operation errors — Git/network patterns are excluded
// so that DNS/connection errors remain retryable by withRetry.
const NON_TRANSIENT = [
	/^Already exists:/,
	/^Source not found:/,
	/^Target already exists:/,
	/^Not found:/,
	/\(os error 2\)/,
	/\(os error 13\)/,
	/\(os error 17\)/,
	/\(os error 28\)/,
	/\(os error 30\)/,
	/\(os error 63\)/,
	/\(os error 66\)/,
];

export function isTransientError(error: unknown): boolean {
	const raw = extractMessage(error);
	return !NON_TRANSIENT.some((p) => p.test(raw));
}

const NETWORK_PATTERNS = [
	/could not resolve host/i,
	// Match "unable to access" only when followed by a network-specific cause,
	// not for HTTP 401/403 authentication/permission failures.
	/unable to access.*(?:could not resolve|connection refused|timed out|network is unreachable|failed to connect)/i,
	/connection refused/i,
	/network is unreachable/i,
	/connection timed out/i,
	/failed to connect/i,
];

export function isNetworkError(error: unknown): boolean {
	const raw = extractMessage(error);
	return NETWORK_PATTERNS.some((p) => p.test(raw));
}
