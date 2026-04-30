import {
	BrowserWindow,
	dialog,
	ipcMain,
	type OpenDialogOptions,
	type OpenDialogReturnValue,
	type SaveDialogReturnValue,
} from "electron";
import type { SaveDialogOptions } from "../../preload/api";

function getParentWindow(): BrowserWindow | undefined {
	return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function showOpenDialog(opts: OpenDialogOptions): Promise<OpenDialogReturnValue> {
	const parent = getParentWindow();
	return parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts);
}

function showSaveDialog(opts: SaveDialogOptions): Promise<SaveDialogReturnValue> {
	const parent = getParentWindow();
	return parent ? dialog.showSaveDialog(parent, opts) : dialog.showSaveDialog(opts);
}

export function registerDialogIpc(): void {
	ipcMain.handle("dialog:open-directory", async (): Promise<string | null> => {
		const result = await showOpenDialog({ properties: ["openDirectory"] });
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	ipcMain.handle("dialog:save", async (_event, opts: SaveDialogOptions): Promise<string | null> => {
		const result = await showSaveDialog(opts);
		if (result.canceled || !result.filePath) return null;
		return result.filePath;
	});
}
