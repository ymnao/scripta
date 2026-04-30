import { ipcMain } from "electron";

const memorySettings = new Map<string, unknown>();

export function registerSettingsIpc(): void {
	ipcMain.handle(
		"settings:get",
		async (_event, key: string): Promise<unknown> =>
			memorySettings.has(key) ? memorySettings.get(key) : null,
	);
	ipcMain.handle("settings:set", async (_event, key: string, value: unknown) => {
		memorySettings.set(key, value);
	});
	ipcMain.handle("settings:delete", async (_event, key: string) => {
		memorySettings.delete(key);
	});
	ipcMain.handle("settings:save", async () => {});
}
