import { ipcMain } from "electron";

export function registerWatcherIpc(): void {
	ipcMain.handle("watcher:start", async (_event, _path: string) => {});
	ipcMain.handle("watcher:stop", async () => {});
}
