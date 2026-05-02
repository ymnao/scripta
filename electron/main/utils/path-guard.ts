import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const allowedRoots = new Set<string>();

// dialog.showSaveDialog でユーザーが明示選択した保存先など、ワークスペース外でも
// 「ユーザーの意図的な書き込み」として 1 回限り許可するパス。
// fs:write 等で assertPathAllowed がマッチした時点で consume（削除）される。
const transientWritePaths = new Set<string>();

export function validatePath(p: string): string {
	if (typeof p !== "string" || p.length === 0) {
		throw new Error("Invalid path: empty");
	}
	if (p.includes("\0")) {
		throw new Error("Invalid path: null byte");
	}
	if (!isAbsolute(p)) {
		throw new Error("Invalid path: must be absolute");
	}
	return resolve(p);
}

// 対象が未存在でも、最も近い実在する祖先を realpath して、その下に suffix を付与した
// パスを返す。これにより:
//  - macOS の /var → /private/var など、root と対象の symlink 解決状態が一致する
//  - 中間ディレクトリが symlink の場合も正しく解決される（symlink-in-the-middle 対策）
// すべての祖先が解決失敗した場合は入力をそのまま返す（fall-through）。
function realpathBestEffort(p: string): string {
	let current = p;
	let suffix = "";
	while (true) {
		try {
			const real = realpathSync(current);
			return suffix ? join(real, suffix) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return p;
			suffix = suffix ? join(basename(current), suffix) : basename(current);
			current = parent;
		}
	}
}

export function registerWorkspaceRoot(p: string): void {
	const validated = validatePath(p);
	allowedRoots.add(realpathBestEffort(validated));
}

export function unregisterWorkspaceRoot(p: string): void {
	const validated = validatePath(p);
	allowedRoots.delete(realpathBestEffort(validated));
}

export function clearWorkspaceRoots(): void {
	allowedRoots.clear();
	transientWritePaths.clear();
}

export function getWorkspaceRoots(): string[] {
	return [...allowedRoots];
}

export function registerTransientWritePath(p: string): void {
	const validated = validatePath(p);
	transientWritePaths.add(realpathBestEffort(validated));
}

export function getTransientWritePaths(): string[] {
	return [...transientWritePaths];
}

function isPathInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

// Fail-closed: ワークスペース未登録 + transient 許可なし → 拒否する。
// 起動時に main/index.ts が saved workspacePath を auto-register することで
// 既存ワークスペースは利用継続でき、初回起動 / ワークスペース未選択時は
// fs:* IPC が一切通らないことが保証される。
export function isPathAllowed(p: string): boolean {
	const target = realpathBestEffort(p);
	if (transientWritePaths.has(target)) return true;
	for (const root of allowedRoots) {
		if (isPathInside(target, root)) return true;
	}
	return false;
}

export function assertPathAllowed(p: string): void {
	const target = realpathBestEffort(p);
	// transient 許可は 1 回限り：マッチしたら consume して return
	if (transientWritePaths.delete(target)) return;
	for (const root of allowedRoots) {
		if (isPathInside(target, root)) return;
	}
	// 違反パスはレンダラに返さず、main 側ログにだけ残す（情報漏洩防止）
	console.warn(`[path-guard] denied outside workspace: ${p}`);
	throw new Error("Permission denied: outside workspace");
}
