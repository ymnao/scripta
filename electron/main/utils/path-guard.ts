import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// fs IPC のガードは window-scoped。allowedRoots は Map<windowId, Set<string>>
// 構造を取り、ある window が `workspace:set` で申告して登録した root だけがその
// window からの fs IPC で許可される（read/list/rename/delete/write 全て同じ Set）。
//
// 信頼境界の補足：approve リスト（workspace.ts の `approvedWorkspacePaths`）は
// プロセス全体で共有される。これは UX 上の選択 — ユーザーが picker で承認した、
// もしくは saved workspacePath として永続化された path は、別ウィンドウからも
// `workspace:set` で切り替えできる方が自然なため。「ウィンドウ A から B の
// workspace を絶対に覗かせない」という強い分離が必要になった場合は、approve も
// window-scoped 化する設計変更が必要（その時は Sidebar の picker → approve の
// 紐付けと、saved workspace 復元の入り口を window 単位で切り直す）。
//
// 現状の保証は「approve 済みでない任意 path に対する権限昇格を防ぐ（main 側で
// reject）」「ある window が register していない root には fs IPC が通らない」
// の 2 点。
const windowAllowedRoots = new Map<number, Set<string>>();

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
//
// fs IPC のたびに realpathSync を呼ぶとイベントループをブロックするため、
// 実在する祖先の realpath 結果を簡易 LRU でキャッシュする。Symlink target の
// 変更は process 寿命中に発生する稀有なケースで、Electron app の典型的な
// 使用シナリオでは許容範囲内と判断。
const realpathCache = new Map<string, string>();
const REALPATH_CACHE_MAX = 256;

function cachedRealpathSync(p: string): string {
	const cached = realpathCache.get(p);
	if (cached !== undefined) {
		// LRU: 末尾に move（Map は insertion order を保つ）
		realpathCache.delete(p);
		realpathCache.set(p, cached);
		return cached;
	}
	const result = realpathSync(p);
	if (realpathCache.size >= REALPATH_CACHE_MAX) {
		const oldest = realpathCache.keys().next().value;
		if (oldest !== undefined) realpathCache.delete(oldest);
	}
	realpathCache.set(p, result);
	return result;
}

export function clearRealpathCache(): void {
	realpathCache.clear();
}

function realpathBestEffort(p: string): string {
	let current = p;
	let suffix = "";
	while (true) {
		try {
			const real = cachedRealpathSync(current);
			return suffix ? join(real, suffix) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return p;
			suffix = suffix ? join(basename(current), suffix) : basename(current);
			current = parent;
		}
	}
}

// validatePath + realpath 正規化済みのパスを返す。workspace.ts のように
// 「path-guard と整合した正規形」で値を保持したい呼び出し側用の helper。
export function canonicalize(p: string): string {
	return realpathBestEffort(validatePath(p));
}

export function registerWorkspaceRoot(windowId: number, p: string): void {
	const canonical = canonicalize(p);
	let set = windowAllowedRoots.get(windowId);
	if (set === undefined) {
		set = new Set<string>();
		windowAllowedRoots.set(windowId, set);
	}
	set.add(canonical);
}

export function unregisterWorkspaceRoot(windowId: number, p: string): void {
	const canonical = canonicalize(p);
	const set = windowAllowedRoots.get(windowId);
	if (set === undefined) return;
	set.delete(canonical);
	if (set.size === 0) windowAllowedRoots.delete(windowId);
}

// 該当ウィンドウが close したときの cleanup。allowedRoots と transientWritePaths を
// まとめて消すことで、後続のゾンビ window-id 経由でガードが緩む事故を防ぐ。
export function clearWorkspaceRootsForWindow(windowId: number): void {
	windowAllowedRoots.delete(windowId);
	transientWritePaths.delete(windowId);
}

export function clearWorkspaceRoots(): void {
	windowAllowedRoots.clear();
	transientWritePaths.clear();
	// テスト間で symlink ターゲットを切り替えるケースに備え、realpath cache も clear する
	realpathCache.clear();
}

export function getWorkspaceRootsForWindow(windowId: number): string[] {
	const set = windowAllowedRoots.get(windowId);
	return set ? [...set] : [];
}

export function registerTransientWritePath(windowId: number, p: string): void {
	const canonical = canonicalize(p);
	let set = transientWritePaths.get(windowId);
	if (set === undefined) {
		set = new Set<string>();
		transientWritePaths.set(windowId, set);
	}
	set.add(canonical);
}

export function consumeTransientWritePath(windowId: number, p: string): boolean {
	// fs:write / fs:write-new は成功時に毎回これを呼ぶため、transient 未登録の
	// 通常保存（workspace 内 write）が hot path。Set 取得を先に行い、
	// 該当 window の Set が無ければ canonicalize（realpath sync）を走らせず即 return。
	const set = transientWritePaths.get(windowId);
	if (set === undefined) return false;
	const canonical = canonicalize(p);
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
	if (rel.length === 0) return false;
	if (isAbsolute(rel)) return false;
	// rel.startsWith("..") だけだと "..backup/foo" のようにディレクトリ名が ".." で
	// 始まる正当なパスを誤って outside 扱いにしてしまう。
	// 「親に上がる」のは rel === ".." または rel が `..${sep}` で始まる場合のみ。
	if (rel === "..") return false;
	if (rel.startsWith(`..${sep}`)) return false;
	return true;
}

function isWithinWindowAllowedRoot(windowId: number, target: string): boolean {
	const set = windowAllowedRoots.get(windowId);
	if (set === undefined) return false;
	for (const root of set) {
		if (isPathInside(target, root)) return true;
	}
	return false;
}

// 内部 helper：validatePath が throw した場合は呼び出し側に伝播する。
// API contract の差を吸収するため isPathAllowed / assertPathAllowed の本体に分離。
function isPathAllowedOrThrow(windowId: number, p: string): boolean {
	// 内部で validate することで、呼び出し側が誤って相対パスを渡した場合も
	// realpath が cwd を base に解決してしまうフットガンを防ぐ
	return isWithinWindowAllowedRoot(windowId, realpathBestEffort(validatePath(p)));
}

// Fail-closed: ウィンドウ未登録時はすべて拒否する。
// renderer 側 AppLayout が settings から読み込んだ workspacePath を workspaceSet で
// 申告した時点で初めて register されるため、初回起動 / ワークスペース未選択時は
// fs:* IPC が一切通らないことが保証される。
//
// この関数は read/list/rename/delete などの非書き込み系で使う。
// SaveDialog 由来の transient write 許可は **参照しない**（write 専用 capability）。
//
// API contract: boolean を返す。validatePath が throw する不正入力（相対パス・
// null byte 等）も、呼び出し側の意図（「許可されているか?」のクエリ）に沿って
// false に寄せる。validate エラーを throw として扱いたい場合は assertPathAllowed
// を使うこと。
export function isPathAllowed(windowId: number, p: string): boolean {
	try {
		return isPathAllowedOrThrow(windowId, p);
	} catch {
		return false;
	}
}

// validatePath が throw する場合（相対パス・null byte 等）は "Invalid path: ..." を
// そのまま投げ、ガード違反は "Permission denied: outside workspace" を投げる。
// 呼び出し側で 2 種類のエラーを区別できる。
export function assertPathAllowed(windowId: number, p: string): void {
	if (isPathAllowedOrThrow(windowId, p)) return;
	// 違反パスはレンダラに返さず、main 側ログにだけ残す（情報漏洩防止）
	console.warn(`[path-guard] denied outside workspace: ${p}`);
	throw new Error("Permission denied: outside workspace");
}

// write 系 IPC（fs:write / fs:write-new）専用ガード。
// 該当 window の workspace root マッチ OR 該当 window の transient set にマッチで許可。
// **consume はしない**（withRetry の再試行中も許可が残るように）。
// 書き込み成功後に consumeTransientWritePath を呼んで明示的に capability を使い切る。
export function assertWritePathAllowed(windowId: number, p: string): void {
	const target = realpathBestEffort(validatePath(p));
	if (isWithinWindowAllowedRoot(windowId, target)) return;
	const set = transientWritePaths.get(windowId);
	if (set?.has(target)) return;
	console.warn(`[path-guard] write denied outside workspace: ${p}`);
	throw new Error("Permission denied: outside workspace");
}
