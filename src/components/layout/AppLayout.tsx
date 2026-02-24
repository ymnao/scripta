import type { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { listDirectory, readFile, writeFile } from "../../lib/commands";
import { processContent } from "../../lib/content";
import { translateError } from "../../lib/errors";
import { addTrailingSep, basename, replacePrefix } from "../../lib/path";
import { loadSettings, saveSidebarVisible, saveWorkspacePath } from "../../lib/store";
import { useSettingsStore } from "../../stores/settings";
import { useThemeStore } from "../../stores/theme";
import { useWorkspaceStore } from "../../stores/workspace";
import { Dialog } from "../common/Dialog";
import { HelpDialog } from "../common/HelpDialog";
import { SettingsDialog } from "../common/SettingsDialog";
import { ToastContainer } from "../common/Toast";
import type { CursorInfo } from "../editor/MarkdownEditor";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { TabBar } from "../editor/TabBar";
import { CommandPalette } from "../search/CommandPalette";
import { SearchBar, type SearchBarHandle } from "../search/SearchBar";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

type GoToLine = { line: number; query?: string } | null;

interface TabCache {
	content: string;
	savedContent: string;
}

export function AppLayout() {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const activeTabId = useWorkspaceStore((s) => s.activeTabId);
	const workspacePath = useWorkspaceStore((s) => s.workspacePath);
	const setWorkspacePath = useWorkspaceStore((s) => s.setWorkspacePath);
	const closeTab = useWorkspaceStore((s) => s.closeTab);
	const closeTabById = useWorkspaceStore((s) => s.closeTabById);
	const setActiveTabById = useWorkspaceStore((s) => s.setActiveTabById);
	const setTabDirty = useWorkspaceStore((s) => s.setTabDirty);
	const renameTab = useWorkspaceStore((s) => s.renameTab);
	const openTab = useWorkspaceStore((s) => s.openTab);
	const navigateInTab = useWorkspaceStore((s) => s.navigateInTab);
	const goBackInTab = useWorkspaceStore((s) => s.goBackInTab);
	const goForwardInTab = useWorkspaceStore((s) => s.goForwardInTab);
	const closeTabsByPrefix = useWorkspaceStore((s) => s.closeTabsByPrefix);
	const renameTabsByPrefix = useWorkspaceStore((s) => s.renameTabsByPrefix);
	const reorderTab = useWorkspaceStore((s) => s.reorderTab);
	const bumpFileTreeVersion = useWorkspaceStore((s) => s.bumpFileTreeVersion);
	const hydratePreference = useThemeStore((s) => s.hydratePreference);
	const hydrateSettings = useSettingsStore((s) => s.hydrate);

	const activeTab = useWorkspaceStore((s) => s.tabs.find((t) => t.id === s.activeTabId));
	const canGoBack = (activeTab?.historyIndex ?? 0) > 0;
	const canGoForward = activeTab ? activeTab.historyIndex < activeTab.history.length - 1 : false;

	const [loading, setLoading] = useState(true);
	const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [searchBarOpen, setSearchBarOpen] = useState(false);
	const [searchBarExpanded, setSearchBarExpanded] = useState(false);
	const [searchBarInitialText, setSearchBarInitialText] = useState("");
	const [sidebarSearchActive, setSidebarSearchActive] = useState(false);
	const [sidebarVisible, setSidebarVisible] = useState(true);
	const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [goToLine, setGoToLine] = useState<GoToLine>(null);
	const editorViewRef = useRef<EditorView | null>(null);
	const [editorView, setEditorView] = useState<EditorView | null>(null);
	const searchBarHandleRef = useRef<SearchBarHandle | null>(null);
	const searchBarOpenRef = useRef(false);
	searchBarOpenRef.current = searchBarOpen;
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const pendingGoToLineRef = useRef<{ line: number; query?: string } | null>(null);

	const [content, setContent] = useState("");
	const [editorKey, setEditorKey] = useState(0);
	const { saveStatus, saveNow, markSaved, waitForPending, getLastSavedContent } = useAutoSave(
		activeTabPath ?? "",
		content,
	);

	const tabCacheRef = useRef(new Map<string, TabCache>());
	const prevTabPathRef = useRef<string | null>(null);
	const contentLoadedForPathRef = useRef<string | null>(null);
	const contentRef = useRef(content);
	contentRef.current = content;
	const savedContentRef = useRef("");
	const saveNowRef = useRef(saveNow);
	saveNowRef.current = saveNow;
	const prevWorkspacePathRef = useRef(workspacePath);
	const justSwitchedRef = useRef(false);

	// New windows (opened via Cmd+Shift+N) carry ?newWindow=true and should not
	// restore or persist the workspace path — only theme and sidebar are restored.
	const [isNewWindow] = useState(() =>
		new URLSearchParams(window.location.search).has("newWindow"),
	);

	// Load persisted settings on mount
	useEffect(() => {
		let cancelled = false;

		(async () => {
			const settings = await loadSettings();
			if (cancelled) return;

			if (!isNewWindow && settings.workspacePath) {
				try {
					await listDirectory(settings.workspacePath);
					if (cancelled) return;
					setWorkspacePath(settings.workspacePath);
				} catch {
					void saveWorkspacePath(null);
				}
			}

			if (cancelled) return;
			hydratePreference(settings.themePreference);
			hydrateSettings({
				showLineNumbers: settings.showLineNumbers,
				fontSize: settings.fontSize,
				autoSaveDelay: settings.autoSaveDelay,
				highlightActiveLine: settings.highlightActiveLine,
				fontFamily: settings.fontFamily,
				trimTrailingWhitespace: settings.trimTrailingWhitespace,
			});
			setSidebarVisible(settings.sidebarVisible);
			setLoading(false);
		})();

		return () => {
			cancelled = true;
		};
	}, [isNewWindow, setWorkspacePath, hydratePreference, hydrateSettings]);

	// Persist workspace path changes (skip while loading and in new windows)
	useEffect(() => {
		if (loading || isNewWindow) return;
		void saveWorkspacePath(workspacePath);
	}, [workspacePath, loading, isNewWindow]);

	// Persist sidebar visibility changes (skip while loading to avoid writing back restored values)
	useEffect(() => {
		if (loading) return;
		void saveSidebarVisible(sidebarVisible);
	}, [sidebarVisible, loading]);

	// Listen for native menu events from Tauri
	useEffect(() => {
		let cancelled = false;
		const unlisteners: Array<() => void> = [];

		void listen("menu-open-settings", () => setSettingsOpen(true)).then((u) => {
			if (cancelled) {
				u();
				return;
			}
			unlisteners.push(u);
		});

		void listen("menu-open-help", () => setHelpOpen(true)).then((u) => {
			if (cancelled) {
				u();
				return;
			}
			unlisteners.push(u);
		});

		return () => {
			cancelled = true;
			for (const u of unlisteners) u();
		};
	}, []);

	// Save all dirty tabs before window closes
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | null = null;

		getCurrentWindow()
			.onCloseRequested(async (event) => {
				event.preventDefault();

				let hasFailed = false;
				const currentActiveTab = useWorkspaceStore.getState().activeTabPath;
				const { trimTrailingWhitespace } = useSettingsStore.getState();

				// Save active tab if dirty
				if (currentActiveTab && contentRef.current !== savedContentRef.current) {
					const saved = await saveNowRef.current();
					if (cancelled) return;
					if (!saved) hasFailed = true;
				}

				// Save all dirty cached non-active tabs with content normalization
				const saves: Promise<{ path: string; ok: boolean; content: string }>[] = [];
				for (const [path, cached] of tabCacheRef.current) {
					if (path !== currentActiveTab && cached.content !== cached.savedContent) {
						const normalized = processContent(cached.content, trimTrailingWhitespace);
						saves.push(
							writeFile(path, normalized).then(
								() => ({ path, ok: true, content: normalized }),
								(err) => {
									console.error("Failed to save file on window close:", err);
									return { path, ok: false, content: normalized };
								},
							),
						);
					}
				}
				const results = await Promise.all(saves);
				if (cancelled) return;
				for (const { path, ok, content } of results) {
					if (ok) {
						const cached = tabCacheRef.current.get(path);
						if (cached) cached.savedContent = content;
						setTabDirty(path, false);
					} else {
						hasFailed = true;
					}
				}

				if (hasFailed) return;
				await getCurrentWindow().destroy();
			})
			.then((fn) => {
				if (cancelled) {
					fn();
				} else {
					unlisten = fn;
				}
			});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [setTabDirty]);

	// Cache previous tab's content and restore new tab's content on switch
	useEffect(() => {
		// Clear cursor info and error when switching tabs
		setCursorInfo(null);
		setEditorError(null);

		const prevPath = prevTabPathRef.current;

		// Clear cache on workspace change (skip saving old tab — it belongs to the old workspace)
		const workspaceChanged = prevWorkspacePathRef.current !== workspacePath;
		if (workspaceChanged) {
			prevWorkspacePathRef.current = workspacePath;
			tabCacheRef.current.clear();
		}

		// Save previous tab to cache (only if content was actually loaded for it
		// and the tab still exists — navigateInTab may change the tab's path)
		if (!workspaceChanged && prevPath && contentLoadedForPathRef.current === prevPath) {
			const tabStillExists = useWorkspaceStore
				.getState()
				.tabs.some((t) => t.path === prevPath || t.history.includes(prevPath));
			if (tabStillExists) {
				const currentCache = tabCacheRef.current.get(prevPath);
				tabCacheRef.current.set(prevPath, {
					content: contentRef.current,
					savedContent: currentCache?.savedContent ?? savedContentRef.current,
				});
			} else {
				tabCacheRef.current.delete(prevPath);
			}
		}

		prevTabPathRef.current = activeTabPath;
		justSwitchedRef.current = true;

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
			setEditorKey((k) => k + 1);
			if (pendingGoToLineRef.current !== null) {
				setGoToLine(pendingGoToLineRef.current);
				pendingGoToLineRef.current = null;
			}
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
				setEditorKey((k) => k + 1);
				if (pendingGoToLineRef.current !== null) {
					setGoToLine(pendingGoToLineRef.current);
					pendingGoToLineRef.current = null;
				}
			})
			.catch((err) => {
				if (ignore) return;
				console.error("Failed to read file:", err);
				setEditorError(translateError(err));
				contentLoadedForPathRef.current = activeTabPath;
				savedContentRef.current = "";
				markSaved("");
				setContent("");
				pendingGoToLineRef.current = null;
			});
		return () => {
			ignore = true;
		};
	}, [activeTabPath, workspacePath, markSaved]);

	// Keep savedContent in cache and ref in sync when save completes.
	// Guard with contentLoadedForPathRef to avoid misattributing a flush save
	// (for the previous file) as a save for the current activeTabPath.
	// Also skip when just switched tabs — contentRef still has the old tab's content.
	useEffect(() => {
		if (justSwitchedRef.current) {
			justSwitchedRef.current = false;
			return;
		}
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

	// Single state ensures only one dialog is shown at a time. When multiple
	// files have conflicts, the latest event wins; earlier conflicts are dropped
	// but dirty content is preserved in memory so no data is lost.
	const [externalConflict, setExternalConflict] = useState<{
		path: string;
		type: "modified" | "deleted";
	} | null>(null);

	// Clear stale conflict dialog when workspace changes.
	// workspacePath is read only to satisfy the exhaustive-deps rule;
	// the real purpose is to trigger on workspace switches.
	const prevWorkspaceRef = useRef(workspacePath);
	useEffect(() => {
		if (prevWorkspaceRef.current !== workspacePath) {
			prevWorkspaceRef.current = workspacePath;
			setExternalConflict(null);
		}
	}, [workspacePath]);

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

	const getLastSavedContentRef = useRef(getLastSavedContent);
	getLastSavedContentRef.current = getLastSavedContent;

	const handleExternalFileModified = useCallback(
		(path: string) => {
			const state = useWorkspaceStore.getState();
			const tab = state.tabs.find((t) => t.path === path);
			if (!tab) return;

			if (path === state.activeTabPath) {
				if (tab.dirty) {
					// Read file to check if this is our own save or genuine external change
					readFile(path)
						.then((loaded) => {
							if (useWorkspaceStore.getState().activeTabPath !== path) return;
							if (loaded === getLastSavedContentRef.current()) {
								// File matches what we last saved — this was our own write
								return;
							}
							// Don't overwrite a pending delete dialog (delete is more severe)
							setExternalConflict((prev) =>
								prev?.type === "deleted" ? prev : { path, type: "modified" },
							);
						})
						.catch((err) => {
							console.error("Failed to read file for conflict check:", err);
						});
				} else {
					readFile(path)
						.then((loaded) => {
							tabCacheRef.current.set(path, { content: loaded, savedContent: loaded });
							// Only update editor state if this file is still the active tab
							if (useWorkspaceStore.getState().activeTabPath !== path) return;
							// Compare with last written content (processed) to detect our own saves
							if (loaded === getLastSavedContentRef.current()) return;
							savedContentRef.current = loaded;
							markSaved(loaded);
							setContent(loaded);
							setEditorKey((k) => k + 1);
						})
						.catch((err) => {
							console.error("Failed to reload file:", err);
						});
				}
			} else {
				// Non-active dirty tabs: intentionally no dialog shown here.
				// Showing a dialog would interrupt the user's current editing.
				// The dirty content stays in cache; the user can reconcile when
				// they switch to that tab.
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
				setTabDirty(path, false);
				// Only update editor state if this file is still the active tab
				if (useWorkspaceStore.getState().activeTabPath === path) {
					savedContentRef.current = loaded;
					markSaved(loaded);
					setContent(loaded);
					setEditorKey((k) => k + 1);
				}
			})
			.catch((err) => {
				console.error("Failed to reload file on conflict resolve:", err);
				// File may have been deleted — notify user via the deleted dialog
				setExternalConflict({ path, type: "deleted" });
			});
	}, [externalConflict, markSaved, setTabDirty]);

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

	const closingTabsRef = useRef<Set<number>>(new Set());

	const handleCloseTab = useCallback(
		async (id: number) => {
			if (closingTabsRef.current.has(id)) return;
			closingTabsRef.current.add(id);

			try {
				const state = useWorkspaceStore.getState();
				const tab = state.tabs.find((t) => t.id === id);
				if (!tab) return;
				const path = tab.path;

				if (id === state.activeTabId) {
					if (contentRef.current !== savedContentRef.current) {
						const saved = await saveNow();
						if (!saved) return;
					}
					tabCacheRef.current.delete(path);
					closeTabById(id);
					return;
				}

				// Non-active tab: wait for any in-flight writes, then save from cache if dirty
				await waitForPending();

				// Re-check: tab may have become active during waitForPending
				const currentState = useWorkspaceStore.getState();
				if (id === currentState.activeTabId) {
					if (contentRef.current !== savedContentRef.current) {
						const saved = await saveNow();
						if (!saved) return;
					}
					tabCacheRef.current.delete(path);
					closeTabById(id);
					return;
				}

				const cached = tabCacheRef.current.get(path);
				if (!cached) {
					// Cache missing (e.g. tab opened but readFile not yet completed).
					// Check store dirty flag to decide if it's safe to close.
					const currentTab = useWorkspaceStore.getState().tabs.find((t) => t.id === id);
					if (currentTab?.dirty) return;
					closeTabById(id);
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
				closeTabById(id);
			} finally {
				closingTabsRef.current.delete(id);
			}
		},
		[saveNow, closeTabById, waitForPending],
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
				}
				renameTabsByPrefix(prefix, addTrailingSep(newPath));
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
		[renameTab, renameTabsByPrefix],
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

	const handleEditorView = useCallback((view: EditorView | null) => {
		editorViewRef.current = view;
		setEditorView(view);
	}, []);

	// Navigation handlers
	const handleFileSelect = useCallback(
		async (path: string) => {
			// Save current file before navigating if dirty
			if (activeTabPath && contentRef.current !== savedContentRef.current) {
				const saved = await saveNow();
				if (!saved) return;
			}
			navigateInTab(path);
		},
		[activeTabPath, navigateInTab, saveNow],
	);

	const handleFileOpenNewTab = useCallback(
		(path: string) => {
			openTab(path);
		},
		[openTab],
	);

	const handleTabSelect = useCallback(
		(id: number) => {
			setActiveTabById(id);
		},
		[setActiveTabById],
	);

	const handleGoBack = useCallback(async () => {
		// Save current file before navigating if dirty
		if (activeTabPath && contentRef.current !== savedContentRef.current) {
			const saved = await saveNow();
			if (!saved) return;
		}
		goBackInTab();
	}, [activeTabPath, goBackInTab, saveNow]);

	const handleGoForward = useCallback(async () => {
		// Save current file before navigating if dirty
		if (activeTabPath && contentRef.current !== savedContentRef.current) {
			const saved = await saveNow();
			if (!saved) return;
		}
		goForwardInTab();
	}, [activeTabPath, goForwardInTab, saveNow]);

	const handleCommandPaletteSelect = useCallback(
		(filePath: string) => {
			openTab(filePath);
		},
		[openTab],
	);

	const handleShowFiles = useCallback(() => {
		setSidebarSearchActive(false);
	}, []);

	const handleShowSearch = useCallback(() => {
		setSidebarSearchActive(true);
		requestAnimationFrame(() => {
			searchInputRef.current?.focus();
		});
	}, []);

	const handleSearchNavigate = useCallback(
		(filePath: string, lineNumber: number, query: string) => {
			const state = useWorkspaceStore.getState();
			if (state.activeTabPath === filePath) {
				setGoToLine({ line: lineNumber, query });
			} else {
				pendingGoToLineRef.current = { line: lineNumber, query };
				openTab(filePath);
			}
		},
		[openTab],
	);

	const handleGoToLineDone = useCallback(() => {
		setGoToLine(null);
	}, []);

	const handleStatistics = useCallback((info: CursorInfo) => {
		setCursorInfo(info);
	}, []);

	// Close search bar when switching away from a file
	useEffect(() => {
		if (!activeTabPath) setSearchBarOpen(false);
	}, [activeTabPath]);

	// Keyboard shortcuts: Cmd+W, Cmd+B, Cmd+F, Cmd+H, Cmd+Shift+F, Cmd+P, Cmd+,, F1, Cmd+[/], Alt+Left/Right
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			// Navigation: Cmd+[ / Alt+Left = back, Cmd+] / Alt+Right = forward
			if ((e.metaKey || e.ctrlKey) && e.key === "[") {
				e.preventDefault();
				handleGoBack();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "]") {
				e.preventDefault();
				handleGoForward();
				return;
			}
			if (e.altKey && e.key === "ArrowLeft") {
				e.preventDefault();
				handleGoBack();
				return;
			}
			if (e.altKey && e.key === "ArrowRight") {
				e.preventDefault();
				handleGoForward();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
				e.preventDefault();
				if (e.shiftKey) {
					// Cmd+Shift+W: タブの有無に関わらずウィンドウを閉じる（未保存の変更は保存される）
					void getCurrentWindow().close();
					return;
				}
				if (activeTabId != null) {
					void handleCloseTab(activeTabId);
				} else {
					// タブがない時はウィンドウを閉じる
					void getCurrentWindow().close();
				}
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
				// Skip sidebar toggle when editor has focus — CodeMirror handles Mod-b for bold
				const view = editorViewRef.current;
				if (view?.hasFocus) return;
				e.preventDefault();
				setSidebarVisible((prev) => !prev);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "e") {
				e.preventDefault();
				setSidebarSearchActive(false);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
				e.preventDefault();
				setSidebarSearchActive(true);
				requestAnimationFrame(() => {
					searchInputRef.current?.focus();
				});
				return;
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "f" || e.key === "h")) {
				const view = editorViewRef.current;
				if (view) {
					e.preventDefault();
					const sel = view.state.selection.main;
					const selectedText =
						!sel.empty && sel.to - sel.from <= 200 ? view.state.sliceDoc(sel.from, sel.to) : "";
					if (searchBarOpenRef.current) {
						// Already open: update text if there's a selection, then re-focus
						if (selectedText) {
							searchBarHandleRef.current?.setSearch(selectedText);
						} else {
							searchBarHandleRef.current?.focusInput();
						}
						if (e.key === "h") setSearchBarExpanded(true);
					} else {
						setSearchBarInitialText(selectedText);
						setSearchBarExpanded(e.key === "h");
						setSearchBarOpen(true);
					}
				}
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "p") {
				e.preventDefault();
				setCommandPaletteOpen((prev) => !prev);
			}
			if ((e.metaKey || e.ctrlKey) && e.key === ",") {
				e.preventDefault();
				setSettingsOpen((prev) => !prev);
			}
			if (e.key === "F1") {
				e.preventDefault();
				setHelpOpen((prev) => !prev);
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [activeTabId, handleCloseTab, handleGoBack, handleGoForward]);

	if (loading) {
		return <div className="flex h-screen flex-col bg-bg-primary text-text-primary" />;
	}

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			<TabBar
				onCloseTab={handleCloseTab}
				onTabSelect={handleTabSelect}
				canGoBack={canGoBack}
				canGoForward={canGoForward}
				onGoBack={handleGoBack}
				onGoForward={handleGoForward}
				onReorderTab={reorderTab}
			/>
			<div className="min-h-0 flex flex-1">
				{sidebarVisible && (
					<Sidebar
						searchActive={sidebarSearchActive}
						onShowFiles={handleShowFiles}
						onShowSearch={handleShowSearch}
						onSearchNavigate={handleSearchNavigate}
						onFileSelect={handleFileSelect}
						onFileOpenNewTab={handleFileOpenNewTab}
						searchInputRef={searchInputRef}
						onFileRenamed={handleFileRenamed}
						onFileDeleted={handleFileDeleted}
					/>
				)}
				<main className="relative min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
					{activeTabPath ? (
						editorError ? (
							<div className="editor-error">
								<p>{editorError}</p>
							</div>
						) : (
							<MarkdownEditor
								key={editorKey}
								value={content}
								onChange={setContent}
								onSave={() => void saveNow()}
								onEditorView={handleEditorView}
								goToLine={goToLine}
								onGoToLineDone={handleGoToLineDone}
								onStatistics={handleStatistics}
							/>
						)
					) : (
						<div className="flex h-full items-center justify-center text-text-secondary">
							<p className="text-sm">Select a file to start editing</p>
						</div>
					)}
					{searchBarOpen && editorView && (
						<SearchBar
							view={editorView}
							onClose={() => setSearchBarOpen(false)}
							initialExpanded={searchBarExpanded}
							initialSearchText={searchBarInitialText}
							handleRef={searchBarHandleRef}
						/>
					)}
				</main>
			</div>
			<StatusBar
				saveStatus={activeTabPath ? saveStatus : undefined}
				cursorInfo={activeTabPath && !editorError ? (cursorInfo ?? undefined) : undefined}
				filePath={
					activeTabPath
						? ((workspacePath
								? activeTabPath.replace(addTrailingSep(workspacePath), "")
								: activeTabPath) ?? undefined)
						: undefined
				}
				onOpenSettings={() => setSettingsOpen(true)}
				onOpenHelp={() => setHelpOpen(true)}
			/>

			{workspacePath && (
				<CommandPalette
					open={commandPaletteOpen}
					workspacePath={workspacePath}
					onSelect={handleCommandPaletteSelect}
					onClose={() => setCommandPaletteOpen(false)}
				/>
			)}

			<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
			<HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
			<ToastContainer />

			<Dialog
				open={externalConflict?.type === "modified"}
				title="ファイルが外部で変更されました"
				description={`「${externalConflict ? basename(externalConflict.path) : ""}」がエディタの外部で変更されました。未保存の変更があります。`}
				confirmLabel="再読み込み"
				cancelLabel="自分の変更を保持"
				onConfirm={handleConflictReload}
				onCancel={handleConflictKeep}
			/>

			<Dialog
				open={externalConflict?.type === "deleted"}
				title="ファイルが外部で削除されました"
				description={`「${externalConflict ? basename(externalConflict.path) : ""}」がエディタの外部で削除されました。未保存の変更があります。`}
				confirmLabel="破棄"
				cancelLabel="編集を続ける"
				onConfirm={handleDeletedDirtyDiscard}
				onCancel={handleDeletedDirtyKeep}
			/>
		</div>
	);
}
