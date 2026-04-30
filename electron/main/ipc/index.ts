import { registerDialogIpc } from "./dialog";
import { registerFsIpc } from "./fs";
import { registerGitIpc } from "./git";
import { registerOgpIpc } from "./ogp";
import { registerPdfIpc } from "./pdf";
import { registerSearchIpc } from "./search";
import { registerSettingsIpc } from "./settings";
import { registerShellIpc } from "./shell";
import { registerUpdateIpc } from "./update";
import { registerWatcherIpc } from "./watcher";
import { registerWindowIpc } from "./window";

export function registerIpcHandlers(): void {
	registerDialogIpc();
	registerFsIpc();
	registerGitIpc();
	registerOgpIpc();
	registerPdfIpc();
	registerSearchIpc();
	registerSettingsIpc();
	registerShellIpc();
	registerUpdateIpc();
	registerWatcherIpc();
	registerWindowIpc();
}
