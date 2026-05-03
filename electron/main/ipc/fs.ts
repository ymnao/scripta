import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { ipcMain, shell } from "electron";
import type { FileEntry } from "../../../src/types/workspace";
import { FsError, isErrnoCode } from "../utils/fs-errors";
import {
	assertPathAllowed,
	assertWritePathAllowed,
	consumeTransientWritePath,
	validatePath,
} from "../utils/path-guard";

async function pathExistsAt(absolute: string): Promise<boolean> {
	try {
		await fsp.access(absolute);
		return true;
	} catch (e) {
		// ENOENT 以外（EACCES, EPERM 等）を握りつぶすと、rename/delete のような
		// 呼び出し元が「実際は権限問題なのに Source not found / Not found」と
		// 誤分類してしまう。ENOENT のみ false 扱いにし、他は呼び出し側に伝播する。
		if (isErrnoCode(e, "ENOENT")) return false;
		throw e;
	}
}

async function readFileImpl(path: string): Promise<string> {
	const resolved = validatePath(path);
	assertPathAllowed(resolved);
	return await fsp.readFile(resolved, "utf8");
}

async function writeFileImpl(senderId: number, path: string, content: string): Promise<void> {
	const resolved = validatePath(path);
	assertWritePathAllowed(senderId, resolved);
	await fsp.mkdir(dirname(resolved), { recursive: true });
	await fsp.writeFile(resolved, content, "utf8");
	// 書き込み成功後にだけ transient capability を消費する。
	// 失敗時は残り、renderer 側 withRetry で再試行できる。
	consumeTransientWritePath(senderId, resolved);
}

async function writeNewFileImpl(senderId: number, path: string, content: string): Promise<void> {
	const resolved = validatePath(path);
	assertWritePathAllowed(senderId, resolved);
	await fsp.mkdir(dirname(resolved), { recursive: true });
	const fh = await fsp.open(resolved, "wx");
	try {
		await fh.writeFile(content, "utf8");
	} finally {
		await fh.close();
	}
	consumeTransientWritePath(senderId, resolved);
}

async function listDirectoryImpl(path: string): Promise<FileEntry[]> {
	const resolved = validatePath(path);
	assertPathAllowed(resolved);
	const entries = await fsp.readdir(resolved, { withFileTypes: true });
	return entries.map((entry) => ({
		name: entry.name,
		path: join(resolved, entry.name),
		isDirectory: entry.isDirectory(),
	}));
}

async function createFileImpl(path: string): Promise<void> {
	const resolved = validatePath(path);
	assertPathAllowed(resolved);
	await fsp.mkdir(dirname(resolved), { recursive: true });
	try {
		const fh = await fsp.open(resolved, "wx");
		await fh.close();
	} catch (e) {
		if (isErrnoCode(e, "EEXIST")) throw FsError.alreadyExists(resolved);
		throw e;
	}
}

async function createDirectoryImpl(path: string): Promise<void> {
	const resolved = validatePath(path);
	assertPathAllowed(resolved);
	// 親は recursive で先に作る。対象自体は非 recursive にすることで
	// 「既存なら EEXIST」を atomic に得る（race-free）。
	await fsp.mkdir(dirname(resolved), { recursive: true });
	try {
		await fsp.mkdir(resolved);
	} catch (e) {
		if (isErrnoCode(e, "EEXIST")) throw FsError.alreadyExists(resolved);
		throw e;
	}
}

async function pathExistsImpl(path: string): Promise<boolean> {
	const resolved = validatePath(path);
	assertPathAllowed(resolved);
	return pathExistsAt(resolved);
}

async function fileExistsImpl(path: string): Promise<boolean> {
	const resolved = validatePath(path);
	assertPathAllowed(resolved);
	try {
		const stat = await fsp.stat(resolved);
		return stat.isFile();
	} catch (e) {
		if (isErrnoCode(e, "ENOENT")) return false;
		throw e;
	}
}

async function renameEntryImpl(oldPath: string, newPath: string): Promise<void> {
	const oldResolved = validatePath(oldPath);
	const newResolved = validatePath(newPath);
	assertPathAllowed(oldResolved);
	assertPathAllowed(newResolved);
	if (!(await pathExistsAt(oldResolved))) throw FsError.sourceNotFound(oldResolved);
	// fs.rename は target 既存時に上書きする default 挙動なので、
	// 「Target already exists」を出すために事前 check が必要。
	// 単一ユーザーの mem アプリのためレースは許容。
	if (await pathExistsAt(newResolved)) throw FsError.targetAlreadyExists(newResolved);
	await fsp.mkdir(dirname(newResolved), { recursive: true });
	await fsp.rename(oldResolved, newResolved);
}

async function deleteEntryImpl(path: string): Promise<void> {
	const resolved = validatePath(path);
	assertPathAllowed(resolved);
	if (!(await pathExistsAt(resolved))) throw FsError.notFound(resolved);
	await shell.trashItem(resolved);
}

export function registerFsIpc(): void {
	ipcMain.handle("fs:read", (_event, path: string) => readFileImpl(path));
	ipcMain.handle("fs:write", (event, path: string, content: string) =>
		writeFileImpl(event.sender.id, path, content),
	);
	ipcMain.handle("fs:write-new", (event, path: string, content: string) =>
		writeNewFileImpl(event.sender.id, path, content),
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
