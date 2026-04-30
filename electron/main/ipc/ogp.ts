import { ipcMain } from "electron";
import type { OgpData } from "../../../src/types/ogp";

export function registerOgpIpc(): void {
	ipcMain.handle(
		"ogp:fetch",
		async (_event, url: string): Promise<OgpData> => ({
			title: null,
			description: null,
			image: null,
			siteName: null,
			url,
		}),
	);
}
