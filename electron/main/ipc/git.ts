import { BrowserWindow, ipcMain } from "electron";
import type { ConflictContent, GitStatus } from "../../../src/types/git-sync";

export function registerGitIpc(): void {
	ipcMain.handle("git:check-available", async () => false);
	ipcMain.handle("git:check-repo", async (_event, _path: string) => false);

	ipcMain.handle(
		"git:status",
		async (_event, _path: string): Promise<GitStatus> => ({
			branch: "",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: false,
		}),
	);

	ipcMain.handle("git:add-all", async (_event, _path: string) => {});
	ipcMain.handle("git:commit", async (_event, _path: string, _message: string) => "");
	ipcMain.handle("git:pull", async (_event, _path: string, _syncMethod: string) => "");
	ipcMain.handle("git:push", async (_event, _path: string) => "");

	ipcMain.handle(
		"git:get-conflicted-files",
		async (_event, _path: string): Promise<string[]> => [],
	);
	ipcMain.handle(
		"git:get-conflict-content",
		async (_event, _path: string, _filePath: string): Promise<ConflictContent> => ({
			ours: "",
			theirs: "",
		}),
	);
	ipcMain.handle(
		"git:resolve-conflict",
		async (
			_event,
			_path: string,
			_filePath: string,
			_content: string,
			_resolution: "modify" | "delete",
		) => {},
	);
	ipcMain.handle("git:finish-conflict-resolution", async (_event, _path: string) => "");
	ipcMain.handle(
		"git:get-last-commit-time",
		async (_event, _path: string): Promise<string | null> => null,
	);

	ipcMain.handle("git:emit-conflict-resolved", async () => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("git:conflict-resolved");
		}
	});
}
