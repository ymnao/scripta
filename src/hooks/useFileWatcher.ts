import { useEffect, useRef } from "react";
import { onFsChange, onWorkspaceReloadTree, startWatcher, stopWatcher } from "../lib/commands";
import { useToastStore } from "../stores/toast";
import type { FsChangeEvent } from "../types/workspace";

interface UseFileWatcherOptions {
	workspacePath: string | null;
	onTreeChange: () => void;
	onFileModified: (path: string) => void;
	onFileDeleted: (path: string) => void;
}

export function useFileWatcher({
	workspacePath,
	onTreeChange,
	onFileModified,
	onFileDeleted,
}: UseFileWatcherOptions) {
	const onTreeChangeRef = useRef(onTreeChange);
	const onFileModifiedRef = useRef(onFileModified);
	const onFileDeletedRef = useRef(onFileDeleted);

	onTreeChangeRef.current = onTreeChange;
	onFileModifiedRef.current = onFileModified;
	onFileDeletedRef.current = onFileDeleted;

	useEffect(() => {
		if (!workspacePath) return;

		let cancelled = false;
		let unlistenFn: (() => void) | null = null;
		let batchTimer: ReturnType<typeof setTimeout> | null = null;
		const pendingEvents = new Map<string, FsChangeEvent["kind"]>();

		const flush = () => {
			batchTimer = null;
			const events = new Map(pendingEvents);
			pendingEvents.clear();

			for (const [path, kind] of events) {
				if (kind === "delete") {
					onFileDeletedRef.current(path);
				} else if (kind === "modify") {
					onFileModifiedRef.current(path);
				}
				// "create" events need no per-file callback; handled by tree refresh below
			}
			// Always refresh — macOS FSEvents may report create/delete as modify.
			// Tree refresh is idempotent so unconditional refresh is safe.
			onTreeChangeRef.current();
		};

		const handleEvents = (batch: FsChangeEvent[]) => {
			for (const event of batch) {
				const existing = pendingEvents.get(event.path);
				if (existing === "create" && event.kind === "modify") {
					// keep create — modification is part of creation
				} else if (existing === "create" && event.kind === "delete") {
					pendingEvents.delete(event.path);
				} else if (existing === "delete" && event.kind === "create") {
					pendingEvents.set(event.path, "modify");
				} else {
					pendingEvents.set(event.path, event.kind);
				}
			}
			// Fixed-deadline batching: the timer starts on the first event arrival
			// and is NOT reset by subsequent events. This matches the Rust-side
			// batching policy (500ms deadline from first event).
			if (batchTimer === null) {
				batchTimer = setTimeout(flush, 300);
			}
		};

		const setup = async () => {
			// subscribe を **startWatcher() の前に** 張る。逆順だと、main 側で
			// chokidar が動き出してから IPC roundtrip が renderer に戻るまでの間に
			// 起きた create/modify/delete が flush されたとき listener が未登録で
			// 取りこぼす。onFsChange は ipcRenderer.on を即時に呼ぶ同期 API なので、
			// この順序にすれば main が emit を始める時点で必ず listener が居る。
			unlistenFn = onFsChange((batch) => {
				if (!cancelled) handleEvents(batch);
			});
			try {
				await startWatcher(workspacePath);
				// startWatcher 中に unmount された場合は cleanup の return が
				// unlistenFn を確実に外すので、ここでは追加処理は不要。
			} catch (err) {
				console.error("Failed to set up file watcher:", err);
				useToastStore.getState().addToast("warning", "ファイル監視の開始に失敗しました");
				// startWatcher が失敗した場合（path-guard で reject 等）、main 側に
				// session が無いため emit は起きないが、不要 listener を残さないために
				// ここで明示的に外す。
				if (unlistenFn) {
					unlistenFn();
					unlistenFn = null;
				}
			}
		};

		void setup();

		// FileTree フィルタ設定が変わったとき main 側から `workspace:reload-tree` が来る。
		// watcher 自体は再起動されないので、renderer の FileTree を再 fetch するだけでよい。
		const unlistenReload = onWorkspaceReloadTree(() => {
			if (!cancelled) onTreeChangeRef.current();
		});

		return () => {
			cancelled = true;
			if (batchTimer !== null) {
				clearTimeout(batchTimer);
			}
			if (unlistenFn) {
				unlistenFn();
			}
			unlistenReload();
			stopWatcher().catch((err) => {
				console.error("Failed to stop file watcher:", err);
			});
		};
	}, [workspacePath]);
}
