import { ipcMain } from "electron";
import { registerWorkspaceRoot, unregisterWorkspaceRoot } from "../utils/path-guard";

let activeWorkspace: string | null = null;

// path-guard に「現在の workspace」を 1 つ持たせるための薄いラッパー。
// フロント側の setWorkspacePath より先に await されることで、
// 新規 workspace 選択時の race（FileTree が register 前に listDirectory を叩く）を防ぐ。
// 起動時の bootstrap も同じ経路を通すことで、register/unregister の整合性を保つ。
export function setActiveWorkspace(path: string | null): void {
	if (activeWorkspace !== null && activeWorkspace !== path) {
		unregisterWorkspaceRoot(activeWorkspace);
	}
	if (path !== null && path !== activeWorkspace) {
		registerWorkspaceRoot(path);
	}
	activeWorkspace = path;
}

export function getActiveWorkspace(): string | null {
	return activeWorkspace;
}

export function registerWorkspaceIpc(): void {
	ipcMain.handle("workspace:set", async (_event, path: string | null) => {
		setActiveWorkspace(path);
	});
}

export const __testing = {
	setActiveWorkspace,
	getActiveWorkspace,
	resetActiveWorkspace: (): void => {
		activeWorkspace = null;
	},
};
