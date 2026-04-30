import { BrowserWindow, dialog, ipcMain } from "electron";
import type { SaveDialogOptions } from "../../preload/api";

function getParentWindow(): BrowserWindow | undefined {
	return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

export function registerDialogIpc(): void {
	ipcMain.handle("dialog:open-directory", async (): Promise<string | null> => {
		const parent = getParentWindow();
		const result = parent
			? await dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
			: await dialog.showOpenDialog({ properties: ["openDirectory"] });
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	ipcMain.handle("dialog:save", async (_event, opts: SaveDialogOptions): Promise<string | null> => {
		const parent = getParentWindow();
		const result = parent
			? await dialog.showSaveDialog(parent, opts)
			: await dialog.showSaveDialog(opts);
		if (result.canceled || !result.filePath) return null;
		return result.filePath;
	});
}
