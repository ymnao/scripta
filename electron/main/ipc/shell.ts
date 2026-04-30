import { ipcMain, shell } from "electron";

export function registerShellIpc(): void {
	ipcMain.handle("shell:open-external", async (_event, url: string) => {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new Error(`Refusing to open non-http(s) URL: ${parsed.protocol}`);
		}
		await shell.openExternal(url);
	});

	ipcMain.handle("shell:show-in-folder", async (_event, path: string) => {
		shell.showItemInFolder(path);
	});
}
