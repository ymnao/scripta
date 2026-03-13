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
];

export function translateError(error: unknown): string {
	const raw = extractMessage(error);
	for (const { test, message } of PATTERNS) {
		if (test.test(raw)) return message;
	}
	return `エラーが発生しました: ${raw}`;
}

const NON_TRANSIENT = PATTERNS.map(({ test }) => test);

export function isTransientError(error: unknown): boolean {
	const raw = extractMessage(error);
	return !NON_TRANSIENT.some((p) => p.test(raw));
}

const NETWORK_PATTERNS = [
	/could not resolve host/i,
	/unable to access/i,
	/connection refused/i,
	/network is unreachable/i,
	/connection timed out/i,
	/failed to connect/i,
];

export function isNetworkError(error: unknown): boolean {
	const raw = extractMessage(error);
	return NETWORK_PATTERNS.some((p) => p.test(raw));
}
