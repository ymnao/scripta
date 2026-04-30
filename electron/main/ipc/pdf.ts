import { ipcMain } from "electron";

export function registerPdfIpc(): void {
	ipcMain.handle("pdf:export", async (_event, _html: string, outputPath: string) => {
		console.warn(`[stage-0b] pdf:export is a no-op. Skipping PDF write to: ${outputPath}`);
	});
}
