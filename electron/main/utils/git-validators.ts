import { isAbsolute } from "node:path";

// 旧 Tauri 版 src-tauri/src/commands/git_sync.rs の validator / 定数を 1:1 で port。
// validateRelativePath / validateRefName は git の path / ref インジェクションを防ぎ、
// isStageNotFound は modify/delete conflict で stage 2 or 3 が無いケースの fallback 判定。

export const MAX_CONFLICT_CONTENT_SIZE = 10 * 1024 * 1024;

// 相対パス文字列を検証する（旧 Rust validate_relative_path 互換）。
// path traversal / NUL byte / 制御文字 / 絶対パスを拒否。
export function validateRelativePath(filePath: string): void {
	if (typeof filePath !== "string" || filePath.length === 0) {
		throw new Error("file_path must not be empty");
	}
	for (let i = 0; i < filePath.length; i++) {
		const c = filePath.charCodeAt(i);
		if (c === 0 || c < 0x20 || c === 0x7f) {
			throw new Error("file_path contains control characters");
		}
	}
	if (isAbsolute(filePath)) {
		throw new Error("file_path must be relative to repository root");
	}
	// `path.normalize` を使うと `..` が解決されて検出できなくなるため、手動で
	// セパレータ単位で確認する。`/` と `\` の両方を区切りとみなす（Windows 経路）。
	for (const seg of filePath.split(/[\\/]/)) {
		if (seg === "..") {
			throw new Error("file_path must not contain '..'");
		}
	}
}

// git ref（branch / remote 名）を検証する（旧 Rust validate_ref_name 互換）。
// 旧 Rust と git-check-ref-format の組み合わせに合わせて defensive に弾く。
export function validateRefName(name: string): void {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("Invalid ref name: empty");
	}
	if (name.startsWith("-") || name.startsWith(".")) {
		throw new Error(`Invalid ref name: ${name}`);
	}
	if (name.endsWith(".lock")) {
		throw new Error(`Invalid ref name: ${name}`);
	}
	for (const ch of ["..", "~", "^", ":", "?", "*", "[", "\\", "@{"]) {
		if (name.includes(ch)) {
			throw new Error(`Invalid ref name: ${name}`);
		}
	}
	for (let i = 0; i < name.length; i++) {
		const c = name.charCodeAt(i);
		// 制御文字 / DEL / 空白を拒否（git のパース上不可）
		if (c < 0x20 || c === 0x7f || c === 0x20) {
			throw new Error(`Invalid ref name: ${name}`);
		}
	}
}

// `git show :2:path` / `:3:path` で stage が存在しない場合（modify/delete conflict）の
// stderr パターン判定。旧 Rust is_stage_not_found 互換。
// 該当パターンに当たれば呼び出し元は空文字列で fallback する。
export function isStageNotFound(stderr: string): boolean {
	return (
		/does not exist/i.test(stderr) ||
		/not at stage/i.test(stderr) ||
		/invalid object name/i.test(stderr) ||
		/not a valid object name/i.test(stderr)
	);
}
