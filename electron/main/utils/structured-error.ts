import { ipcMain } from "electron";
import {
	type ErrorKind,
	encodeIpcError,
	type StructuredErrorData,
} from "../../../src/types/errors";

// main 側の構造化エラー基盤。
//
// - `StructuredError`: kind / code / path を保持する Error。ハンドラはこれを throw する。
// - `classifyErrno` / `classifyGitError`: 生 errno / git stderr を ErrorKind へ分類する。
//   旧 renderer 側 errors.ts の正規表現パースは、この main 側分類器へ移設された
//   （= エラーを生成する側で 1 度だけ分類し、renderer は kind で分岐する）。
// - `handle`: ipcMain.handle のラッパー。reject 時に任意のエラーを構造化し、
//   `encodeIpcError` で sentinel + JSON を message に埋めて IPC を越えさせる。

export class StructuredError extends Error {
	readonly kind: ErrorKind;
	readonly code?: string;
	readonly path?: string;

	constructor(kind: ErrorKind, message: string, opts?: { code?: string; path?: string }) {
		super(message);
		this.name = "StructuredError";
		this.kind = kind;
		this.code = opts?.code;
		this.path = opts?.path;
	}
}

// NodeJS.ErrnoException.code を ErrorKind へ。未知の errno は UNKNOWN。
const ERRNO_TO_KIND: Record<string, ErrorKind> = {
	ENOENT: "ENOENT",
	EACCES: "EACCES",
	EPERM: "EACCES",
	EEXIST: "EEXIST",
	EISDIR: "EISDIR",
	ENOTDIR: "ENOTDIR",
	ENOSPC: "ENOSPC",
	EROFS: "EROFS",
	EAGAIN: "EAGAIN",
	EBUSY: "EBUSY",
	ENAMETOOLONG: "ENAMETOOLONG",
	ENOTEMPTY: "ENOTEMPTY",
	EMFILE: "EMFILE",
	ENFILE: "EMFILE",
};

export function classifyErrno(code: string | undefined): ErrorKind {
	if (code && code in ERRNO_TO_KIND) return ERRNO_TO_KIND[code];
	return "UNKNOWN";
}

// git の stderr（LC_ALL=C で英語固定）を ErrorKind へ分類する。
// 並びは優先順位を持つ: network 由来は「unable to access」wrapper より先に判定し、
// HTTP 401/403（authentication / 一般 access 不能）と切り分ける。
export function classifyGitError(stderr: string): ErrorKind {
	if (/could not resolve host|network is unreachable|failed to connect/i.test(stderr)) {
		return "NETWORK";
	}
	if (/connection refused/i.test(stderr)) return "CONNECTION_REFUSED";
	if (/connection timed out|timed?\s*out/i.test(stderr)) return "TIMEOUT";
	if (/authentication failed/i.test(stderr)) return "GIT_AUTH";
	if (/conflict/i.test(stderr)) return "GIT_CONFLICT";
	if (/nothing (?:to commit|added to commit)/i.test(stderr)) return "GIT_NOTHING_TO_COMMIT";
	if (/unable to access/i.test(stderr)) return "GIT_NO_REMOTE_ACCESS";
	return "UNKNOWN";
}

// git stderr 文字列から StructuredError を生成する。
// message には生 stderr を保持し（UNKNOWN 時の "詳細" 表示 / デバッグ用）、
// kind は classifyGitError で決める。
export function gitError(stderr: string): StructuredError {
	return new StructuredError(classifyGitError(stderr), stderr);
}

// 型ガード: NodeJS.ErrnoException 形状か。
function hasErrnoCode(e: unknown): e is { code: string; message?: string } {
	return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string";
}

// 任意のエラーを構造化 payload へ。
// - StructuredError → そのまま
// - errno を持つ Error → errno を分類
// - それ以外 → UNKNOWN（message を保持）
export function toStructuredData(err: unknown): StructuredErrorData {
	if (err instanceof StructuredError) {
		return { kind: err.kind, message: err.message, code: err.code, path: err.path };
	}
	if (hasErrnoCode(err)) {
		return {
			kind: classifyErrno(err.code),
			message: typeof err.message === "string" ? err.message : String(err),
			code: err.code,
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return { kind: "UNKNOWN", message };
}

// reject 用に、構造化 payload を sentinel + JSON へエンコードした Error を返す。
// この Error の message が IPC を越えて renderer へ運ばれ、preload で decode される。
export function serializeIpcError(err: unknown): Error {
	return new Error(encodeIpcError(toStructuredData(err)));
}

// biome-ignore lint/suspicious/noExplicitAny: ipcMain.handle の listener シグネチャに合わせる
type IpcListener = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;

// ipcMain.handle のラッパー。listener が throw / reject した場合に
// serializeIpcError で構造化し、renderer へ kind 付きで伝える。
// 成功時はそのまま値を返す（fast path にラップのオーバーヘッドのみ）。
export function handle(channel: string, listener: IpcListener): void {
	ipcMain.handle(channel, async (event, ...args) => {
		try {
			return await listener(event, ...args);
		} catch (err) {
			throw serializeIpcError(err);
		}
	});
}
