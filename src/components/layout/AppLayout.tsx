import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { readFile, writeFile } from "../../lib/commands";
import { useWorkspaceStore } from "../../stores/workspace";
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
			<div className="flex flex-1 overflow-hidden">
				<Sidebar />
				<main className="flex-1 overflow-hidden">
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
		</div>
	);
}
