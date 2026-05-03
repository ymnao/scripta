import { ipcMain } from "electron";
import { canonicalize, registerWorkspaceRoot, unregisterWorkspaceRoot } from "../utils/path-guard";

// renderer 経由で workspace:set を受け付ける際、main 側で「ユーザーが OS ネイティブ
// な操作（dialog.showOpenDialog や前回 settings 経由）で承認した path」だけを
// 許可するための approved 集合。
// これがないと、悪意ある/侵害された renderer が workspaceSet("/") のような任意 path
// で path-guard の allowedRoots を拡張し、ファイル I/O を全面解放できてしまう。
const approvedWorkspacePaths = new Set<string>();

export function approveWorkspacePath(rawPath: string): void {
	approvedWorkspacePaths.add(canonicalize(rawPath));
}

export function isWorkspacePathApproved(rawPath: string): boolean {
	try {
		return approvedWorkspacePaths.has(canonicalize(rawPath));
	} catch {
		// validatePath が throw する不正入力（相対パス・null byte 等）も拒否扱い
		return false;
	}
}

// 複数ウィンドウ対応のため、各 window (webContents.id 単位) が現在開いている
// workspace を保持する。allowedRoots（path-guard）への register/unregister は
// この Map の使用 count に従ってのみ行う：
//   - ある path を最初に使う window が現れたら register
//   - その path を使う window がゼロになったら unregister
// これにより「ウィンドウ A で /A、ウィンドウ B で /B」のような構成で、
// 一方の workspace:set が他方の root を奪わないことを保証する。
//
// Map に格納する値は canonicalize()（validatePath + realpath 正規化）後の文字列。
// raw 文字列のまま保持すると、symlink 経由・大小文字差・/var → /private/var
// などの表記揺れで「同じ実体なのに ref-count で別物扱い」となり、
// 他 window がまだ使っているのに unregister が走る事故が起こる。
const windowWorkspaces = new Map<number, string>();

function isPathStillUsedByOtherWindow(canonical: string, excludeWindowId: number): boolean {
	for (const [id, p] of windowWorkspaces) {
		if (id !== excludeWindowId && p === canonical) return true;
	}
	return false;
}

function isPathUsedByAnyWindow(canonical: string): boolean {
	for (const p of windowWorkspaces.values()) {
		if (p === canonical) return true;
	}
	return false;
}

export function setActiveWorkspaceForWindow(webContentsId: number, path: string | null): void {
	const canonical = path === null ? null : canonicalize(path);
	const previous = windowWorkspaces.get(webContentsId);
	if (previous === canonical) return;

	if (previous !== undefined) {
		windowWorkspaces.delete(webContentsId);
		if (!isPathStillUsedByOtherWindow(previous, webContentsId)) {
			unregisterWorkspaceRoot(previous);
		}
	}

	if (canonical !== null) {
		const alreadyRegistered = isPathUsedByAnyWindow(canonical);
		windowWorkspaces.set(webContentsId, canonical);
		if (!alreadyRegistered) {
			registerWorkspaceRoot(canonical);
		}
	}
}

// ウィンドウが close された時に呼ぶ。そのウィンドウだけが使っていた path は
// allowedRoots からも消える（fail-closed の整合性を保つ）。
export function unregisterWindow(webContentsId: number): void {
	const path = windowWorkspaces.get(webContentsId);
	if (path === undefined) return;
	windowWorkspaces.delete(webContentsId);
	if (!isPathUsedByAnyWindow(path)) {
		unregisterWorkspaceRoot(path);
	}
}

export function registerWorkspaceIpc(): void {
	ipcMain.handle("workspace:set", async (event, path: string | null) => {
		// renderer は任意 path を投げ得る。dialog 経由 / settings 経由で main が
		// 承認した path 集合に無い場合は拒否し、信頼境界を main 側に閉じ込める。
		// path === null（unregister）は常に許可。
		if (path !== null && !isWorkspacePathApproved(path)) {
			console.warn(`[workspace] rejected non-approved path: ${path}`);
			throw new Error("Permission denied: workspace not approved");
		}
		setActiveWorkspaceForWindow(event.sender.id, path);
	});
}

export const __testing = {
	setActiveWorkspaceForWindow,
	unregisterWindow,
	getWindowWorkspaces: (): Map<number, string> => new Map(windowWorkspaces),
	getApprovedWorkspacePaths: (): Set<string> => new Set(approvedWorkspacePaths),
	reset: (): void => {
		windowWorkspaces.clear();
		approvedWorkspacePaths.clear();
	},
};
