import { promises as fsp } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { shell } from "electron";
import type { FileEntry } from "../../../src/types/workspace";
import { createEntryFilter } from "../utils/entry-filter";
import { FsError, isErrnoCode } from "../utils/fs-errors";
import { handle } from "../utils/ipc-handle";
import {
	assertPathAllowed,
	assertWritePathAllowed,
	consumeTransientWritePath,
	findContainingWorkspaceRoot,
} from "../utils/path-guard";
import { getFileTreeFilterOptions } from "./settings";

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

// すべての impl は path-guard の assert 系から **canonical（realpath 済み）** を
// 受け取り、I/O にもその canonical を使う。これで:
//   1. 判定と実 I/O が同一パスになるため TOCTOU で symlink を差し替えられても
//      workspace 外アクセスが成立しない
//   2. validate + realpath が impl 内で 1 回だけになり、二重正規化のオーバーヘッドが消える

async function readFileImpl(senderId: number, path: string): Promise<string> {
	const canonical = assertPathAllowed(senderId, path);
	return await fsp.readFile(canonical, "utf8");
}

async function writeFileImpl(senderId: number, path: string, content: string): Promise<void> {
	const canonical = assertWritePathAllowed(senderId, path);
	await fsp.mkdir(dirname(canonical), { recursive: true });
	// **意図的に直接書き込み**。tmp + rename の atomic write は user workspace の
	// .md ファイルには使わない。理由（VS Code microsoft/vscode#195539 と同方針）:
	//   - inode が置き換わると symlink / hardlink が切れる
	//   - macOS の任意 xattr（Finder タグ、独自 metadata）と ACL が失われる
	//   - 外部 file watcher / Dropbox / iCloud / Git working tree の inode 安定性が崩れる
	// 引き換えに ENOSPC / SIGKILL 中の partial write リスクは残るが、user 編集中
	// ファイルでは metadata 保存と inode 安定性のほうが優先（#100 で wontfix 判断）。
	// app 内部 data (settings.ts / pdf.ts) は inode 安定性が問題にならないため、
	// そちらは引き続き write-file-atomic を使用している。
	await fsp.writeFile(canonical, content, "utf8");
	// 書き込み成功後にだけ transient capability を消費する。
	// 失敗時は残り、renderer 側 withRetry で再試行できる。
	consumeTransientWritePath(senderId, canonical);
}

async function writeNewFileImpl(senderId: number, path: string, content: string): Promise<void> {
	const canonical = assertWritePathAllowed(senderId, path);
	await fsp.mkdir(dirname(canonical), { recursive: true });
	const fh = await fsp.open(canonical, "wx");
	try {
		await fh.writeFile(content, "utf8");
	} finally {
		await fh.close();
	}
	consumeTransientWritePath(senderId, canonical);
}

async function listDirectoryImpl(
	senderId: number,
	path: string,
	opts?: unknown,
): Promise<FileEntry[]> {
	const canonical = assertPathAllowed(senderId, path);
	const entries = await fsp.readdir(canonical, { withFileTypes: true });
	// 戻り値の path は renderer が保持する workspacePath（raw 入力側）と表記を揃える。
	// canonical（symlink 解決後）を返してしまうと、macOS の /var → /private/var、
	// symlink workspace などで FileTree の `replacePrefix(workspacePath, ...)` /
	// `startsWith(workspacePath)` 等の前提が崩れる。
	// I/O は canonical で行う（TOCTOU 防止）一方、戻り値の path は input 表記に揃える。
	const inputResolved = resolve(path);
	// gitignore 仕様の `/build/`（root アンカー）等を正しく評価するため、フィルタには
	// listing 中の directory ではなく workspace root を渡す。opts は IPC 経由 renderer 由来
	// （null / 文字列 / 配列等が渡りうる）なので、plain object かを確認したうえで boolean
	// 比較で fail-closed に判定する。
	const applyFilter =
		typeof opts === "object" &&
		opts !== null &&
		!Array.isArray(opts) &&
		(opts as Record<string, unknown>).applyFileTreeFilter === true;
	const workspaceRoot = applyFilter ? findContainingWorkspaceRoot(senderId, canonical) : null;
	const filter =
		workspaceRoot !== null ? createEntryFilter(getFileTreeFilterOptions(), workspaceRoot) : null;
	return entries
		.filter((entry) => filter?.(join(canonical, entry.name), entry.isDirectory()) ?? true)
		.map((entry) => ({
			name: entry.name,
			path: join(inputResolved, entry.name),
			isDirectory: entry.isDirectory(),
		}));
}

async function createFileImpl(senderId: number, path: string): Promise<void> {
	const canonical = assertPathAllowed(senderId, path);
	await fsp.mkdir(dirname(canonical), { recursive: true });
	try {
		const fh = await fsp.open(canonical, "wx");
		await fh.close();
	} catch (e) {
		if (isErrnoCode(e, "EEXIST")) throw FsError.alreadyExists(canonical);
		throw e;
	}
}

async function createDirectoryImpl(senderId: number, path: string): Promise<void> {
	const canonical = assertPathAllowed(senderId, path);
	// 親は recursive で先に作る。対象自体は非 recursive にすることで
	// 「既存なら EEXIST」を atomic に得る（race-free）。
	await fsp.mkdir(dirname(canonical), { recursive: true });
	try {
		await fsp.mkdir(canonical);
	} catch (e) {
		if (isErrnoCode(e, "EEXIST")) throw FsError.alreadyExists(canonical);
		throw e;
	}
}

async function pathExistsImpl(senderId: number, path: string): Promise<boolean> {
	const canonical = assertPathAllowed(senderId, path);
	return pathExistsAt(canonical);
}

async function fileExistsImpl(senderId: number, path: string): Promise<boolean> {
	const canonical = assertPathAllowed(senderId, path);
	try {
		const stat = await fsp.stat(canonical);
		return stat.isFile();
	} catch (e) {
		if (isErrnoCode(e, "ENOENT")) return false;
		throw e;
	}
}

async function renameEntryImpl(senderId: number, oldPath: string, newPath: string): Promise<void> {
	const oldCanonical = assertPathAllowed(senderId, oldPath);
	const newCanonical = assertPathAllowed(senderId, newPath);
	if (!(await pathExistsAt(oldCanonical))) throw FsError.sourceNotFound(oldCanonical);
	// fs.rename は target 既存時に上書きする default 挙動なので、
	// 「Target already exists」を出すために事前 check が必要。
	// 単一ユーザーの mem アプリのためレースは許容。
	if (await pathExistsAt(newCanonical)) throw FsError.targetAlreadyExists(newCanonical);
	await fsp.mkdir(dirname(newCanonical), { recursive: true });
	await fsp.rename(oldCanonical, newCanonical);
}

async function deleteEntryImpl(senderId: number, path: string): Promise<void> {
	const canonical = assertPathAllowed(senderId, path);
	if (!(await pathExistsAt(canonical))) throw FsError.notFound(canonical);
	await shell.trashItem(canonical);
}

export function registerFsIpc(): void {
	handle("fs:read", (event, path: string) => readFileImpl(event.sender.id, path));
	handle("fs:write", (event, path: string, content: string) =>
		writeFileImpl(event.sender.id, path, content),
	);
	handle("fs:write-new", (event, path: string, content: string) =>
		writeNewFileImpl(event.sender.id, path, content),
	);
	handle("fs:list", (event, path: string, opts?: unknown) =>
		listDirectoryImpl(event.sender.id, path, opts),
	);
	handle("fs:create-file", (event, path: string) => createFileImpl(event.sender.id, path));
	handle("fs:create-directory", (event, path: string) =>
		createDirectoryImpl(event.sender.id, path),
	);
	handle("fs:path-exists", (event, path: string) => pathExistsImpl(event.sender.id, path));
	handle("fs:file-exists", (event, path: string) => fileExistsImpl(event.sender.id, path));
	handle("fs:rename", (event, oldPath: string, newPath: string) =>
		renameEntryImpl(event.sender.id, oldPath, newPath),
	);
	handle("fs:delete", (event, path: string) => deleteEntryImpl(event.sender.id, path));
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
