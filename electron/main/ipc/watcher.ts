import { ipcMain } from "electron";
import { registerWorkspaceRoot, unregisterWorkspaceRoot, validatePath } from "../utils/path-guard";

let activeRoot: string | null = null;

export function registerWatcherIpc(): void {
	ipcMain.handle("watcher:start", async (_event, path: string) => {
		const resolved = validatePath(path);
		if (activeRoot && activeRoot !== resolved) {
			unregisterWorkspaceRoot(activeRoot);
		}
		registerWorkspaceRoot(resolved);
		activeRoot = resolved;
	});
	ipcMain.handle("watcher:stop", async () => {
		if (activeRoot) {
			unregisterWorkspaceRoot(activeRoot);
			activeRoot = null;
		}
	});
}
