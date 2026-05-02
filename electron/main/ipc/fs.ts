import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { ipcMain, shell } from "electron";
import type { FileEntry } from "../../../src/types/workspace";
import { assertReadAllowed, assertWriteAllowed, validatePath } from "../utils/path-guard";

async function pathExistsAt(absolute: string): Promise<boolean> {
	try {
		await fsp.access(absolute);
		return true;
	} catch {
		return false;
	}
}

async function readFileImpl(path: string): Promise<string> {
	const resolved = validatePath(path);
	assertReadAllowed(resolved);
	return await fsp.readFile(resolved, "utf8");
}

async function writeFileImpl(path: string, content: string): Promise<void> {
	const resolved = validatePath(path);
	assertWriteAllowed(resolved);
	await fsp.mkdir(dirname(resolved), { recursive: true });
	await fsp.writeFile(resolved, content, "utf8");
}

async function writeNewFileImpl(path: string, content: string): Promise<void> {
	const resolved = validatePath(path);
	assertWriteAllowed(resolved);
	await fsp.mkdir(dirname(resolved), { recursive: true });
	const fh = await fsp.open(resolved, "wx");
	try {
		await fh.writeFile(content, "utf8");
	} finally {
		await fh.close();
	}
}

async function listDirectoryImpl(path: string): Promise<FileEntry[]> {
	const resolved = validatePath(path);
	assertReadAllowed(resolved);
	const entries = await fsp.readdir(resolved, { withFileTypes: true });
	return entries.map((entry) => ({
		name: entry.name,
		path: join(resolved, entry.name),
		isDirectory: entry.isDirectory(),
	}));
}

async function createFileImpl(path: string): Promise<void> {
	const resolved = validatePath(path);
	assertWriteAllowed(resolved);
	if (await pathExistsAt(resolved)) {
		throw new Error(`Already exists: ${resolved}`);
	}
	await fsp.mkdir(dirname(resolved), { recursive: true });
	const fh = await fsp.open(resolved, "wx");
	await fh.close();
}

async function createDirectoryImpl(path: string): Promise<void> {
	const resolved = validatePath(path);
	assertWriteAllowed(resolved);
	if (await pathExistsAt(resolved)) {
		throw new Error(`Already exists: ${resolved}`);
	}
	await fsp.mkdir(resolved, { recursive: true });
}

async function pathExistsImpl(path: string): Promise<boolean> {
	const resolved = validatePath(path);
	assertReadAllowed(resolved);
	return pathExistsAt(resolved);
}

async function fileExistsImpl(path: string): Promise<boolean> {
	const resolved = validatePath(path);
	assertReadAllowed(resolved);
	try {
		const stat = await fsp.stat(resolved);
		return stat.isFile();
	} catch {
		return false;
	}
}

async function renameEntryImpl(oldPath: string, newPath: string): Promise<void> {
	const oldResolved = validatePath(oldPath);
	const newResolved = validatePath(newPath);
	assertWriteAllowed(oldResolved);
	assertWriteAllowed(newResolved);
	if (!(await pathExistsAt(oldResolved))) {
		throw new Error(`Source not found: ${oldResolved}`);
	}
	if (await pathExistsAt(newResolved)) {
		throw new Error(`Target already exists: ${newResolved}`);
	}
	await fsp.mkdir(dirname(newResolved), { recursive: true });
	await fsp.rename(oldResolved, newResolved);
}

async function deleteEntryImpl(path: string): Promise<void> {
	const resolved = validatePath(path);
	assertWriteAllowed(resolved);
	if (!(await pathExistsAt(resolved))) {
		throw new Error(`Not found: ${resolved}`);
	}
	await shell.trashItem(resolved);
}

export function registerFsIpc(): void {
	ipcMain.handle("fs:read", (_event, path: string) => readFileImpl(path));
	ipcMain.handle("fs:write", (_event, path: string, content: string) =>
		writeFileImpl(path, content),
	);
	ipcMain.handle("fs:write-new", (_event, path: string, content: string) =>
		writeNewFileImpl(path, content),
	);
	ipcMain.handle("fs:list", (_event, path: string) => listDirectoryImpl(path));
	ipcMain.handle("fs:create-file", (_event, path: string) => createFileImpl(path));
	ipcMain.handle("fs:create-directory", (_event, path: string) => createDirectoryImpl(path));
	ipcMain.handle("fs:path-exists", (_event, path: string) => pathExistsImpl(path));
	ipcMain.handle("fs:file-exists", (_event, path: string) => fileExistsImpl(path));
	ipcMain.handle("fs:rename", (_event, oldPath: string, newPath: string) =>
		renameEntryImpl(oldPath, newPath),
	);
	ipcMain.handle("fs:delete", (_event, path: string) => deleteEntryImpl(path));
}

export const __testing = {
	readFileImpl,
	writeFileImpl,
	writeNewFileImpl,
	listDirectoryImpl,
	createFileImpl,
	createDirectoryImpl,
	pathExistsImpl,
	fileExistsImpl,
	renameEntryImpl,
	deleteEntryImpl,
};
