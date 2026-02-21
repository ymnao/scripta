import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { readFile, writeFile } from "../../lib/commands";
import { addTrailingSep, basename, replacePrefix } from "../../lib/path";
import { useWorkspaceStore } from "../../stores/workspace";
import { Dialog } from "../common/Dialog";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { TabBar } from "../editor/TabBar";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

interface TabCache {
	content: string;
	savedContent: string;
}

export function AppLayout() {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const workspacePath = useWorkspaceStore((s) => s.workspacePath);
	const closeTab = useWorkspaceStore((s) => s.closeTab);
	const setTabDirty = useWorkspaceStore((s) => s.setTabDirty);
	const renameTab = useWorkspaceStore((s) => s.renameTab);
	const closeTabsByPrefix = useWorkspaceStore((s) => s.closeTabsByPrefix);
	const bumpFileTreeVersion = useWorkspaceStore((s) => s.bumpFileTreeVersion);

	const [content, setContent] = useState("");
	const { saveStatus, saveNow, markSaved, waitForPending } = useAutoSave(
		activeTabPath ?? "",
		content,
	);

	const tabCacheRef = useRef(new Map<string, TabCache>());
	const prevTabPathRef = useRef<string | null>(null);
	const contentLoadedForPathRef = useRef<string | null>(null);
	const contentRef = useRef(content);
	contentRef.current = content;
	const savedContentRef = useRef("");
	const prevWorkspacePathRef = useRef(workspacePath);

	// Cache previous tab's content and restore new tab's content on switch
	useEffect(() => {
		const prevPath = prevTabPathRef.current;

		// Clear cache on workspace change (skip saving old tab — it belongs to the old workspace)
		const workspaceChanged = prevWorkspacePathRef.current !== workspacePath;
		if (workspaceChanged) {
			prevWorkspacePathRef.current = workspacePath;
			tabCacheRef.current.clear();
		}

		// Save previous tab to cache (only if content was actually loaded for it)
		if (!workspaceChanged && prevPath && contentLoadedForPathRef.current === prevPath) {
			const currentCache = tabCacheRef.current.get(prevPath);
			tabCacheRef.current.set(prevPath, {
				content: contentRef.current,
				savedContent: currentCache?.savedContent ?? savedContentRef.current,
			});
		}

		prevTabPathRef.current = activeTabPath;

		if (!activeTabPath) {
			contentLoadedForPathRef.current = null;
			setContent("");
			savedContentRef.current = "";
			markSaved("");
			return;
		}

		const cached = tabCacheRef.current.get(activeTabPath);
		if (cached) {
			contentLoadedForPathRef.current = activeTabPath;
			savedContentRef.current = cached.savedContent;
			markSaved(cached.savedContent);
			setContent(cached.content);
			return;
		}

		// No cache — load from disk
		let ignore = false;
		contentLoadedForPathRef.current = null;
		readFile(activeTabPath)
			.then((loaded) => {
				if (ignore) return;
				contentLoadedForPathRef.current = activeTabPath;
				savedContentRef.current = loaded;
				markSaved(loaded);
				setContent(loaded);
			})
			.catch((err) => {
				if (ignore) return;
				console.error("Failed to read file:", err);
				contentLoadedForPathRef.current = activeTabPath;
				savedContentRef.current = "";
				markSaved("");
				setContent("");
			});
		return () => {
			ignore = true;
		};
	}, [activeTabPath, workspacePath, markSaved]);

	// Keep savedContent in cache and ref in sync when save completes.
	// Guard with contentLoadedForPathRef to avoid misattributing a flush save
	// (for the previous file) as a save for the current activeTabPath.
	useEffect(() => {
		if (
			activeTabPath &&
			saveStatus === "saved" &&
			contentLoadedForPathRef.current === activeTabPath
		) {
			savedContentRef.current = contentRef.current;
			const cached = tabCacheRef.current.get(activeTabPath);
			if (cached) {
				cached.savedContent = contentRef.current;
			}
		}
	}, [activeTabPath, saveStatus]);

	// Sync dirty flag to store.
	// Guard with contentLoadedForPathRef to avoid misattributing a stale saveStatus
	// (from the previous file's flush) to the newly active tab.
	useEffect(() => {
		if (activeTabPath && contentLoadedForPathRef.current === activeTabPath) {
			setTabDirty(activeTabPath, saveStatus !== "saved");
		}
	}, [activeTabPath, saveStatus, setTabDirty]);

	const [externalConflict, setExternalConflict] = useState<{
		path: string;
		type: "modified" | "deleted";
	} | null>(null);

	const handleTreeChange = useCallback(() => {
		bumpFileTreeVersion();
	}, [bumpFileTreeVersion]);

	const handleExternalFileDeleted = useCallback(
		(path: string) => {
			const tab = useWorkspaceStore.getState().tabs.find((t) => t.path === path);
			if (!tab) return;

			if (tab.dirty) {
				// Deletion supersedes any pending conflict (modified) dialog
				setExternalConflict({ path, type: "deleted" });
			} else {
				tabCacheRef.current.delete(path);
				closeTab(path);
			}
		},
		[closeTab],
	);

	const handleExternalFileModified = useCallback(
		(path: string) => {
			const state = useWorkspaceStore.getState();
			const tab = state.tabs.find((t) => t.path === path);
			if (!tab) return;

			if (path === state.activeTabPath) {
				if (tab.dirty) {
					// Don't overwrite a pending delete dialog (delete is more severe)
					setExternalConflict((prev) =>
						prev?.type === "deleted" ? prev : { path, type: "modified" },
					);
				} else {
					readFile(path)
						.then((loaded) => {
							if (loaded === savedContentRef.current) return;
							savedContentRef.current = loaded;
							markSaved(loaded);
							setContent(loaded);
							tabCacheRef.current.set(path, { content: loaded, savedContent: loaded });
						})
						.catch((err) => {
							console.error("Failed to reload file:", err);
						});
				}
			} else {
				const cached = tabCacheRef.current.get(path);
				if (cached && cached.content === cached.savedContent) {
					readFile(path)
						.then((loaded) => {
							tabCacheRef.current.set(path, { content: loaded, savedContent: loaded });
						})
						.catch((err) => {
							console.error("Failed to reload cached file:", err);
						});
				}
			}
		},
		[markSaved],
	);

	useFileWatcher({
		workspacePath,
		onTreeChange: handleTreeChange,
		onFileModified: handleExternalFileModified,
		onFileDeleted: handleExternalFileDeleted,
	});

	const handleConflictReload = useCallback(() => {
		if (externalConflict?.type !== "modified") return;
		const path = externalConflict.path;
		setExternalConflict(null);
		readFile(path)
			.then((loaded) => {
				tabCacheRef.current.set(path, { content: loaded, savedContent: loaded });
				// Only update editor state if this file is still the active tab
				if (useWorkspaceStore.getState().activeTabPath === path) {
					savedContentRef.current = loaded;
					markSaved(loaded);
					setContent(loaded);
				}
			})
			.catch((err) => {
				console.error("Failed to reload file on conflict resolve:", err);
			});
	}, [externalConflict, markSaved]);

	const handleConflictKeep = useCallback(() => {
		setExternalConflict(null);
	}, []);

	const handleDeletedDirtyDiscard = useCallback(() => {
		if (externalConflict?.type !== "deleted") return;
		const path = externalConflict.path;
		setExternalConflict(null);
		tabCacheRef.current.delete(path);
		closeTab(path);
	}, [externalConflict, closeTab]);

	const handleDeletedDirtyKeep = useCallback(() => {
		setExternalConflict(null);
	}, []);

	const closingTabsRef = useRef<Set<string>>(new Set());

	const handleCloseTab = useCallback(
		async (path: string) => {
			if (closingTabsRef.current.has(path)) return;
			closingTabsRef.current.add(path);

			try {
				if (path === activeTabPath) {
					if (contentRef.current !== savedContentRef.current) {
						const saved = await saveNow();
						if (!saved) return;
					}
					tabCacheRef.current.delete(path);
					closeTab(path);
					return;
				}

				// Non-active tab: wait for any in-flight writes, then save from cache if dirty
				await waitForPending();

				// Re-check: tab may have become active during waitForPending
				if (path === useWorkspaceStore.getState().activeTabPath) {
					if (contentRef.current !== savedContentRef.current) {
						const saved = await saveNow();
						if (!saved) return;
					}
					tabCacheRef.current.delete(path);
					closeTab(path);
					return;
				}

				const cached = tabCacheRef.current.get(path);
				if (!cached) {
					// Cache missing (e.g. tab opened but readFile not yet completed).
					// Check store dirty flag to decide if it's safe to close.
					const tab = useWorkspaceStore.getState().tabs.find((t) => t.path === path);
					if (tab?.dirty) return;
					closeTab(path);
					return;
				}
				if (cached.content !== cached.savedContent) {
					try {
						await writeFile(path, cached.content);
					} catch (err) {
						console.error("Failed to save file on close:", err);
						return;
					}
				}
				tabCacheRef.current.delete(path);
				closeTab(path);
			} finally {
				closingTabsRef.current.delete(path);
			}
		},
		[activeTabPath, saveNow, closeTab, waitForPending],
	);

	const handleFileRenamed = useCallback(
		(oldPath: string, newPath: string, isDirectory: boolean) => {
			// Helper: update tracking refs so the tab-switch effect doesn't
			// re-create a stale cache entry under the old path.
			const updateRefs = (oldKey: string, newKey: string) => {
				if (prevTabPathRef.current === oldKey) {
					prevTabPathRef.current = newKey;
				}
				if (contentLoadedForPathRef.current === oldKey) {
					contentLoadedForPathRef.current = newKey;
				}
			};

			if (isDirectory) {
				const prefix = addTrailingSep(oldPath);
				const cache = tabCacheRef.current;
				const updates: { oldKey: string; newKey: string; value: TabCache }[] = [];

				for (const [key, value] of cache) {
					if (key.startsWith(prefix)) {
						updates.push({ oldKey: key, newKey: replacePrefix(key, oldPath, newPath), value });
					}
				}

				for (const { oldKey, newKey, value } of updates) {
					cache.delete(oldKey);
					cache.set(newKey, value);
					updateRefs(oldKey, newKey);
					renameTab(oldKey, newKey);
				}
			} else {
				const cached = tabCacheRef.current.get(oldPath);
				if (cached) {
					tabCacheRef.current.delete(oldPath);
					tabCacheRef.current.set(newPath, cached);
				}
				updateRefs(oldPath, newPath);
				renameTab(oldPath, newPath);
			}
		},
		[renameTab],
	);

	const handleFileDeleted = useCallback(
		(path: string, isDirectory: boolean) => {
			if (isDirectory) {
				const prefix = addTrailingSep(path);
				for (const key of tabCacheRef.current.keys()) {
					if (key.startsWith(prefix)) {
						tabCacheRef.current.delete(key);
					}
				}
				closeTabsByPrefix(prefix);
			} else {
				tabCacheRef.current.delete(path);
				closeTab(path);
			}
		},
		[closeTab, closeTabsByPrefix],
	);

	// Cmd+W / Ctrl+W to close active tab
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "w") {
				e.preventDefault();
				if (activeTabPath) void handleCloseTab(activeTabPath);
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [activeTabPath, handleCloseTab]);

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<TabBar onCloseTab={handleCloseTab} />
			<div className="min-h-0 flex flex-1">
				<Sidebar onFileRenamed={handleFileRenamed} onFileDeleted={handleFileDeleted} />
				<main className="min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
					{activeTabPath ? (
						<MarkdownEditor value={content} onChange={setContent} onSave={() => void saveNow()} />
					) : (
						<div className="flex h-full items-center justify-center text-text-secondary">
							<p className="text-sm">Select a file to start editing</p>
						</div>
					)}
				</main>
			</div>
			<StatusBar saveStatus={activeTabPath ? saveStatus : undefined} />

			<Dialog
				open={externalConflict?.type === "modified"}
				title="File changed externally"
				description={`"${externalConflict?.type === "modified" ? basename(externalConflict.path) : ""}" has been modified outside the editor. You have unsaved changes.`}
				confirmLabel="Reload"
				cancelLabel="Keep my changes"
				onConfirm={handleConflictReload}
				onCancel={handleConflictKeep}
			/>

			<Dialog
				open={externalConflict?.type === "deleted"}
				title="File deleted externally"
				description={`"${externalConflict?.type === "deleted" ? basename(externalConflict.path) : ""}" has been deleted outside the editor. You have unsaved changes.`}
				confirmLabel="Discard"
				cancelLabel="Keep editing"
				onConfirm={handleDeletedDirtyDiscard}
				onCancel={handleDeletedDirtyKeep}
			/>
		</div>
	);
}
