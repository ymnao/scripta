import { app, BrowserWindow, ipcMain, session } from "electron";

export function registerWindowIpc(): void {
	ipcMain.handle("app:get-version", async () => app.getVersion());

	ipcMain.handle("window:close", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		win?.close();
	});

	ipcMain.handle("window:open-conflict", async (_event, workspacePath: string) => {
		console.warn(
			`[stage-0b] window:open-conflict is a no-op. Will be implemented in Stage 4. workspace=${workspacePath}`,
		);
	});

	ipcMain.handle("window:clear-webview-data", async () => {
		await session.defaultSession.clearStorageData();
	});
}
