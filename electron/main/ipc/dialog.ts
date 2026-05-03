import {
	BrowserWindow,
	dialog,
	ipcMain,
	type OpenDialogOptions,
	type OpenDialogReturnValue,
	type SaveDialogReturnValue,
} from "electron";
import type { SaveDialogOptions } from "../../preload/api";
import { registerTransientWritePath } from "../utils/path-guard";
import { approveWorkspacePath } from "./workspace";

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
		// OS ネイティブな folder picker を通過した path のみを「ユーザー承認済み」として
		// approve リストに入れる。renderer が workspace:set を打つ際の信頼境界。
		approveWorkspacePath(result.filePaths[0]);
		return result.filePaths[0];
	});

	ipcMain.handle("dialog:save", async (_event, opts: SaveDialogOptions): Promise<string | null> => {
		const result = await showSaveDialog(opts);
		if (result.canceled || !result.filePath) return null;
		// ユーザーが明示的に選択した保存先は workspace 外でも書き込みを許可する。
		// transient 許可は 1 回限り（fs:write の path-guard で consume される）。
		registerTransientWritePath(result.filePath);
		return result.filePath;
	});
}
