import { shell } from "electron";
import { handle } from "../utils/structured-error";
import { isSafeExternalUrl } from "../utils/url";

export function registerShellIpc(): void {
	handle("shell:open-external", async (_event, url: string) => {
		if (!isSafeExternalUrl(url)) {
			throw new Error(`Refusing to open unsafe URL: ${url}`);
		}
		await shell.openExternal(url);
	});

	handle("shell:show-in-folder", async (_event, path: string) => {
		shell.showItemInFolder(path);
	});
}
