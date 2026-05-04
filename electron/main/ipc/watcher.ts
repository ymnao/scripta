import { ipcMain } from "electron";

// Stage 1: no-op。Stage 2 で chokidar による実装に置き換える。
// Workspace ルートの登録は workspace:set IPC が責務を持つ。
export function registerWatcherIpc(): void {
	ipcMain.handle("watcher:start", async (_event, _path: string) => {});
	ipcMain.handle("watcher:stop", async () => {});
}
