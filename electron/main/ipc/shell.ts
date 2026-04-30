import { ipcMain, shell } from "electron";
import { isSafeExternalUrl } from "../utils/url";

export function registerShellIpc(): void {
	ipcMain.handle("shell:open-external", async (_event, url: string) => {
		if (!isSafeExternalUrl(url)) {
			throw new Error(`Refusing to open unsafe URL: ${url}`);
		}
		await shell.openExternal(url);
	});

	ipcMain.handle("shell:show-in-folder", async (_event, path: string) => {
		shell.showItemInFolder(path);
	});
}
