import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const allowedRoots = new Set<string>();

// dialog.showSaveDialog でユーザーが明示選択した保存先など、ワークスペース外でも
// 「ユーザーの意図的な書き込み」として 1 回限り許可するパス。
// 設計上の重要点：
//   1. window 単位（webContents.id）でスコープ。別ウィンドウから消費できない
//   2. read/list/rename/delete 等の非書き込み IPC では参照しない（write 専用 capability）
//   3. consume（削除）は assertWritePathAllowed の時点ではなく書き込み成功後。
//      これで withRetry の再試行（EBUSY/EAGAIN 等）が transient を temporarily 失わない
//   4. window close 時に該当 window の transient を全削除して cleanup
const transientWritePaths = new Map<number, Set<string>>();

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

function isWithinAnyAllowedRoot(target: string): boolean {
	for (const root of allowedRoots) {
		if (isPathInside(target, root)) return true;
	}
	return false;
}

export function getWorkspaceRoots(): string[] {
	return [...allowedRoots];
}

export function registerTransientWritePath(windowId: number, p: string): void {
	const canonical = realpathBestEffort(validatePath(p));
	let set = transientWritePaths.get(windowId);
	if (set === undefined) {
		set = new Set<string>();
		transientWritePaths.set(windowId, set);
	}
	set.add(canonical);
}

export function consumeTransientWritePath(windowId: number, p: string): boolean {
	const canonical = realpathBestEffort(validatePath(p));
	const set = transientWritePaths.get(windowId);
	if (set === undefined) return false;
	const removed = set.delete(canonical);
	if (set.size === 0) transientWritePaths.delete(windowId);
	return removed;
}

export function clearTransientWritePathsForWindow(windowId: number): void {
	transientWritePaths.delete(windowId);
}

export function getTransientWritePathsForWindow(windowId: number): string[] {
	const set = transientWritePaths.get(windowId);
	return set ? [...set] : [];
}

function isPathInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

// validatePath + realpath 正規化済みのパスを返す。workspace.ts のように
// 「path-guard と整合した正規形」で値を保持したい呼び出し側用の helper。
export function canonicalize(p: string): string {
	return realpathBestEffort(validatePath(p));
}

// Fail-closed: ワークスペース未登録時はすべて拒否する。
// renderer 側 AppLayout が settings から読み込んだ workspacePath を workspaceSet で
// 申告した時点で初めて register されるため、初回起動 / ワークスペース未選択時は
// fs:* IPC が一切通らないことが保証される。
//
// この関数は read/list/rename/delete などの非書き込み系で使う。
// SaveDialog 由来の transient write 許可は **参照しない**（write 専用 capability）。
export function isPathAllowed(p: string): boolean {
	// 内部で validate することで、呼び出し側が誤って相対パスを渡した場合も
	// realpath が cwd を base に解決してしまうフットガンを防ぐ
	return isWithinAnyAllowedRoot(realpathBestEffort(validatePath(p)));
}

export function assertPathAllowed(p: string): void {
	if (isPathAllowed(p)) return;
	// 違反パスはレンダラに返さず、main 側ログにだけ残す（情報漏洩防止）
	console.warn(`[path-guard] denied outside workspace: ${p}`);
	throw new Error("Permission denied: outside workspace");
}

// write 系 IPC（fs:write / fs:write-new）専用ガード。
// workspace root マッチ OR 該当 window の transient set にマッチで許可。
// **consume はしない**（withRetry の再試行中も許可が残るように）。
// 書き込み成功後に consumeTransientWritePath を呼んで明示的に capability を使い切る。
export function assertWritePathAllowed(windowId: number, p: string): void {
	const target = realpathBestEffort(validatePath(p));
	if (isWithinAnyAllowedRoot(target)) return;
	const set = transientWritePaths.get(windowId);
	if (set?.has(target)) return;
	console.warn(`[path-guard] write denied outside workspace: ${p}`);
	throw new Error("Permission denied: outside workspace");
}
