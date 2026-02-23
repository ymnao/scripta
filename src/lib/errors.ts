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
];

export function translateError(error: unknown): string {
	const raw = extractMessage(error);
	for (const { test, message } of PATTERNS) {
		if (test.test(raw)) return message;
	}
	return `エラーが発生しました: ${raw}`;
}

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
];

export function isTransientError(error: unknown): boolean {
	const raw = extractMessage(error);
	return !NON_TRANSIENT.some((p) => p.test(raw));
}
