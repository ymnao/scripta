import { ipcMain } from "electron";
import type { FileEntry } from "../../../src/types/workspace";

const memoryFs = new Map<string, string>();

export function registerFsIpc(): void {
	ipcMain.handle("fs:read", async (_event, path: string) => {
		const content = memoryFs.get(path);
		if (content === undefined) throw new Error(`File not found: ${path}`);
		return content;
	});

	ipcMain.handle("fs:write", async (_event, path: string, content: string) => {
		memoryFs.set(path, content);
	});

	ipcMain.handle("fs:write-new", async (_event, path: string, content: string) => {
		if (memoryFs.has(path)) throw new Error(`File already exists: ${path}`);
		memoryFs.set(path, content);
	});

	ipcMain.handle("fs:list", async (_event, _path: string): Promise<FileEntry[]> => []);

	ipcMain.handle("fs:create-file", async (_event, path: string) => {
		memoryFs.set(path, "");
	});

	ipcMain.handle("fs:create-directory", async (_event, _path: string) => {});

	ipcMain.handle("fs:path-exists", async (_event, path: string) => memoryFs.has(path));
	ipcMain.handle("fs:file-exists", async (_event, path: string) => memoryFs.has(path));

	ipcMain.handle("fs:rename", async (_event, oldPath: string, newPath: string) => {
		const value = memoryFs.get(oldPath);
		if (value === undefined) throw new Error(`File not found: ${oldPath}`);
		memoryFs.delete(oldPath);
		memoryFs.set(newPath, value);
	});

	ipcMain.handle("fs:delete", async (_event, path: string) => {
		memoryFs.delete(path);
	});
}
