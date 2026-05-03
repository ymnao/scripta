import { ipcMain } from "electron";
import { canonicalize, registerWorkspaceRoot, unregisterWorkspaceRoot } from "../utils/path-guard";

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
		setActiveWorkspaceForWindow(event.sender.id, path);
	});
}

export const __testing = {
	setActiveWorkspaceForWindow,
	unregisterWindow,
	getWindowWorkspaces: (): Map<number, string> => new Map(windowWorkspaces),
	reset: (): void => {
		windowWorkspaces.clear();
	},
};
