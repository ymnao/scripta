import { ipcMain } from "electron";
import { registerWorkspaceRoot, unregisterWorkspaceRoot } from "../utils/path-guard";

// 複数ウィンドウ対応のため、各 window (webContents.id 単位) が現在開いている
// workspace を保持する。allowedRoots（path-guard）への register/unregister は
// この Map の使用 count に従ってのみ行う：
//   - ある path を最初に使う window が現れたら register
//   - その path を使う window がゼロになったら unregister
// これにより「ウィンドウ A で /A、ウィンドウ B で /B」のような構成で、
// 一方の workspace:set が他方の root を奪わないことを保証する。
const windowWorkspaces = new Map<number, string>();

function isPathStillUsedByOtherWindow(path: string, excludeWindowId: number): boolean {
	for (const [id, p] of windowWorkspaces) {
		if (id !== excludeWindowId && p === path) return true;
	}
	return false;
}

function isPathUsedByAnyWindow(path: string): boolean {
	for (const p of windowWorkspaces.values()) {
		if (p === path) return true;
	}
	return false;
}

export function setActiveWorkspaceForWindow(webContentsId: number, path: string | null): void {
	const previous = windowWorkspaces.get(webContentsId);
	if (previous === path) return;

	if (previous !== undefined) {
		windowWorkspaces.delete(webContentsId);
		if (!isPathStillUsedByOtherWindow(previous, webContentsId)) {
			unregisterWorkspaceRoot(previous);
		}
	}

	if (path !== null) {
		const alreadyRegistered = isPathUsedByAnyWindow(path);
		windowWorkspaces.set(webContentsId, path);
		if (!alreadyRegistered) {
			registerWorkspaceRoot(path);
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
