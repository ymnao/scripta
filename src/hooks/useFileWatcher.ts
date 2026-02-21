import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { startWatcher, stopWatcher } from "../lib/commands";
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
			if (batchTimer === null) {
				batchTimer = setTimeout(flush, 300);
			}
		};

		startWatcher(workspacePath).catch((err) => {
			console.error("Failed to start file watcher:", err);
		});

		listen<FsChangeEvent[]>("fs-change", (event) => {
			if (!cancelled) {
				handleEvents(event.payload);
			}
		}).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlistenFn = fn;
			}
		});

		return () => {
			cancelled = true;
			if (batchTimer !== null) {
				clearTimeout(batchTimer);
			}
			if (unlistenFn) {
				unlistenFn();
			}
			stopWatcher().catch((err) => {
				console.error("Failed to stop file watcher:", err);
			});
		};
	}, [workspacePath]);
}
