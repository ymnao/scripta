import { StructuredError } from "./structured-error";

// fs ハンドラが文脈付きで投げる「意味的な」ファイル操作エラーのファクトリ。
// 生 errno（EEXIST 等）だけでは区別できない「rename の source 不在」と
// 「delete の対象不在」などを ErrorKind で区別し、renderer 側 errors.ts が
// kind から日本語 UI メッセージを導出する。message は開発者向けの生文字列
// （UNKNOWN 以外の kind では UI 表示に使われない）。
export const FsError = {
	alreadyExists: (p: string): StructuredError =>
		new StructuredError("ALREADY_EXISTS", `Already exists: ${p}`, { path: p }),
	sourceNotFound: (p: string): StructuredError =>
		new StructuredError("SOURCE_NOT_FOUND", `Source not found: ${p}`, { path: p }),
	targetAlreadyExists: (p: string): StructuredError =>
		new StructuredError("TARGET_ALREADY_EXISTS", `Target already exists: ${p}`, { path: p }),
	notFound: (p: string): StructuredError =>
		new StructuredError("NOT_FOUND", `Not found: ${p}`, { path: p }),
	tooLarge: (p: string, bytes: number, limit: number): StructuredError =>
		new StructuredError(
			"FILE_TOO_LARGE",
			`File too large: ${p} (${bytes} bytes exceeds ${limit} byte limit)`,
			{ path: p },
		),
};

export function isErrnoCode(e: unknown, code: string): boolean {
	return typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;
}
