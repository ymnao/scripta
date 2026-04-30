import { ipcMain } from "electron";
import type { UpdateInfo } from "../../../src/types/update";

export function registerUpdateIpc(): void {
	ipcMain.handle(
		"update:check",
		async (_event, currentVersion: string): Promise<UpdateInfo> => ({
			hasUpdate: false,
			latestVersion: currentVersion,
			currentVersion,
			releaseUrl: "",
		}),
	);
}
