// 旧 Tauri 版と同じ message 形式を保ち、フロント側 errors.ts の正規表現
// (`/^Already exists:/` など) でマッチさせるための定数 + ファクトリ。
// 生文字列を fs ハンドラに散らさず、タイポで翻訳が落ちる事故を防ぐ。
export const FsError = {
	alreadyExists: (p: string): Error => new Error(`Already exists: ${p}`),
	sourceNotFound: (p: string): Error => new Error(`Source not found: ${p}`),
	targetAlreadyExists: (p: string): Error => new Error(`Target already exists: ${p}`),
	notFound: (p: string): Error => new Error(`Not found: ${p}`),
};

export function isErrnoCode(e: unknown, code: string): boolean {
	return typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;
}
