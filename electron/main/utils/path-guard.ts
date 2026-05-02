import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const allowedRoots = new Set<string>();

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
}

export function getWorkspaceRoots(): string[] {
	return [...allowedRoots];
}

function isPathInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isPathAllowed(p: string): boolean {
	if (allowedRoots.size === 0) return true;
	const target = realpathBestEffort(p);
	for (const root of allowedRoots) {
		if (isPathInside(target, root)) return true;
	}
	return false;
}

export function assertPathAllowed(p: string): void {
	if (!isPathAllowed(p)) {
		// 違反パスはレンダラに返さず、main 側ログにだけ残す（情報漏洩防止）
		console.warn(`[path-guard] denied outside workspace: ${p}`);
		throw new Error("Permission denied: outside workspace");
	}
}
