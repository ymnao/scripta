import { existsSync } from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";
import { ipcMain, type WebContents } from "electron";
import type { FsChangeEvent } from "../../../src/types/workspace";
import { assertPathAllowed } from "../utils/path-guard";
import { type FsKind, isHidden, mergeEventKind, reclassifyDeleted } from "../utils/watcher-pure";

// session は webContents.id（windowId 相当）で索引する。各 window は同時に 1 つしか
// watcher を持たない（旧 Tauri の WatcherState と同じ前提）。watcher:start で既存
// セッションがあれば必ず先に stop してから新設する。
type Session = {
	watcher: FSWatcher;
	pending: Map<string, FsKind>;
	flushTimer: NodeJS.Timeout | null;
	webContents: WebContents;
	root: string;
	// 停止後にも listener closure 経由で生き残った session に late event が飛んで
	// くるため、flush / onFsEvent 先頭で短絡するためのフラグ。chokidar.close() は
	// async だが、stopped は **synchronous に** true にすることで「stop した後の
	// イベントは絶対に送らない」を保証する。
	stopped: boolean;
};

const sessions = new Map<number, Session>();

const BATCH_DEADLINE_MS = 500;

function flush(session: Session): void {
	if (session.stopped) return;
	reclassifyDeleted(session.pending, existsSync);
	const batch: FsChangeEvent[] = [];
	for (const [path, kind] of session.pending) {
		batch.push({ kind, path });
	}
	session.pending.clear();
	session.flushTimer = null;
	if (batch.length === 0) return;
	if (session.webContents.isDestroyed()) return;
	session.webContents.send("watcher:fs-change", batch);
}

function onFsEvent(session: Session, kind: FsKind, path: string): void {
	if (session.stopped) return;
	if (isHidden(path, session.root)) return;
	mergeEventKind(session.pending, path, kind);
	// 「最初の event で deadline 設定、後続ではリセットしない」（旧 Rust 1:1）。
	// flushTimer === null は「pending が空 or 直前 flush 完了」を意味する。
	if (session.pending.size > 0 && session.flushTimer === null) {
		session.flushTimer = setTimeout(() => flush(session), BATCH_DEADLINE_MS);
	}
}

function startSession(webContents: WebContents, root: string): Session {
	const watcher = chokidar.watch(root, {
		persistent: true,
		ignoreInitial: true,
		followSymlinks: false,
		ignored: (p: string) => isHidden(p, root),
	});

	const session: Session = {
		watcher,
		pending: new Map(),
		flushTimer: null,
		webContents,
		root,
		stopped: false,
	};

	watcher.on("add", (p) => onFsEvent(session, "create", p));
	watcher.on("addDir", (p) => onFsEvent(session, "create", p));
	watcher.on("change", (p) => onFsEvent(session, "modify", p));
	watcher.on("unlink", (p) => onFsEvent(session, "delete", p));
	watcher.on("unlinkDir", (p) => onFsEvent(session, "delete", p));
	watcher.on("error", (err) => {
		console.warn("[watcher] error:", err);
	});

	return session;
}

// window close / watcher:stop 共通の停止処理。pending は **捨てる**（旧 Rust の
// stale event 防止と同じ判断 — explicit stop で前 workspace の遅延通知が次の
// workspace に漏れる事故を防ぐ）。
//
// chokidar.close() は非同期で、close() 完了前に listener closure 経由で onFsEvent が
// 走り得る。stopped フラグを **synchronous に** 立てることで、close 完了を待たずとも
// 「stop した瞬間以降のイベントは renderer に届かない」を保証する（race 防止）。
export function stopWatcherForWindow(windowId: number): void {
	const session = sessions.get(windowId);
	if (session === undefined) return;
	session.stopped = true;
	if (session.flushTimer !== null) {
		clearTimeout(session.flushTimer);
		session.flushTimer = null;
	}
	void session.watcher.close().catch((err) => {
		console.warn("[watcher] close failed:", err);
	});
	sessions.delete(windowId);
}

export function registerWatcherIpc(): void {
	ipcMain.handle("watcher:start", async (event, rawPath: string) => {
		// 必ず path-guard を通す。未承認 path で chokidar を起動させないため。
		// canonical を chokidar に渡すことで TOCTOU 抑止 + workspace.ts の表記と整合する。
		const canonical = assertPathAllowed(event.sender.id, rawPath);
		stopWatcherForWindow(event.sender.id);
		sessions.set(event.sender.id, startSession(event.sender, canonical));
	});

	ipcMain.handle("watcher:stop", async (event) => {
		stopWatcherForWindow(event.sender.id);
	});
}
