import type { EditorView } from "@codemirror/view";
import {
	type ComponentType,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { useGitSync } from "../../hooks/useGitSync";
import { useScratchpadVolatile } from "../../hooks/useScratchpadVolatile";
import { useShortcuts } from "../../hooks/useShortcuts";
import { useTabContentManager } from "../../hooks/useTabContentManager";
import { useUpdateCheck } from "../../hooks/useUpdateCheck";
import {
	clearWebviewBrowsingData,
	listDirectory,
	onMenuEvent,
	onWindowCloseRequested,
	openConflictWindow,
	readFile,
	workspaceSet,
} from "../../lib/commands";
import { translateError } from "../../lib/errors";
import { addTrailingSep, basename, isNewTabPath } from "../../lib/path";
import {
	extractSlideFrontmatterTheme,
	findSlideAtCursor,
	parseSlides,
} from "../../lib/slide-parser";
import { loadSettings, saveSetting } from "../../lib/store";
import { useBacklinkStore } from "../../stores/backlink";
import { useGitSyncStore } from "../../stores/git-sync";
import { useScratchpadStore } from "../../stores/scratchpad";
import { useSettingsStore } from "../../stores/settings";
import { useThemeStore } from "../../stores/theme";
import { useToastStore } from "../../stores/toast";
import { useWikilinkStore } from "../../stores/wikilink";
import { selectNavigation, useWorkspaceStore } from "../../stores/workspace";
import { useWorkspaceConfigStore } from "../../stores/workspace-config";
import type { SlideSection, SlideTheme } from "../../types/slide";
import { Dialog } from "../common/Dialog";
import { DirectoryPickerDialog } from "../common/DirectoryPickerDialog";
import { ExportDialog } from "../common/ExportDialog";
import { HelpDialog } from "../common/HelpDialog";
import { SettingsDialog } from "../common/SettingsDialog";
import { SetupWizardDialog } from "../common/SetupWizardDialog";
import { ToastContainer } from "../common/Toast";
import { FONT_FAMILY_MAP } from "../editor/editor-theme";
import type { CursorInfo, GoToLineRequest } from "../editor/MarkdownEditor";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { ScratchpadPanel, type ScratchpadSaveHandle } from "../editor/ScratchpadPanel";
import { TabBar } from "../editor/TabBar";
import { CommandPalette } from "../search/CommandPalette";
import { GoToLineDialog } from "../search/GoToLineDialog";
import { SearchBar, type SearchBarHandle } from "../search/SearchBar";
import type { SlideShowOverlayProps } from "../slide/SlideShowOverlay";
import { SlideView } from "../slide/SlideView";
import { buildAppShortcuts } from "./appShortcuts";
import { NewTabContent } from "./NewTabContent";
import { Sidebar, type SidebarPanel } from "./Sidebar";
import { StatusBar } from "./StatusBar";

// SlideShowOverlay → markdown-to-html → katex の静的 import チェーンを初期チャンクから
// 切り離すため lazy 化する (SlidePreview と同じ意図、#301)。F5 押下まで load しない。
const SlideShowOverlay = lazy(
	(): Promise<{ default: ComponentType<SlideShowOverlayProps> }> =>
		import("../slide/SlideShowOverlay").then((m) => ({ default: m.SlideShowOverlay })),
);

type GoToLine = GoToLineRequest | null;

export function AppLayout() {
	const {
		activeTabPath,
		activeTabId,
		workspacePath,
		setWorkspacePath,
		closeTab,
		setActiveTabById,
		openTab,
		navigateInTab,
		goBackInTab,
		goForwardInTab,
		reorderTab,
		openNewTab,
		activateNextTab,
		activatePrevTab,
		bumpFileTreeVersion,
	} = useWorkspaceStore(
		useShallow((s) => ({
			activeTabPath: s.activeTabPath,
			activeTabId: s.activeTabId,
			workspacePath: s.workspacePath,
			setWorkspacePath: s.setWorkspacePath,
			closeTab: s.closeTab,
			setActiveTabById: s.setActiveTabById,
			openTab: s.openTab,
			navigateInTab: s.navigateInTab,
			goBackInTab: s.goBackInTab,
			goForwardInTab: s.goForwardInTab,
			reorderTab: s.reorderTab,
			openNewTab: s.openNewTab,
			activateNextTab: s.activateNextTab,
			activatePrevTab: s.activatePrevTab,
			bumpFileTreeVersion: s.bumpFileTreeVersion,
		})),
	);
	const { canGoBack, canGoForward } = useWorkspaceStore(useShallow(selectNavigation));

	const {
		loadIcons,
		resetWorkspaceConfig,
		scriptaDirReady,
		setScriptaDirReady,
		workspaceInitialized,
		configLoaded,
		setWorkspaceInitialized,
	} = useWorkspaceConfigStore(
		useShallow((s) => ({
			loadIcons: s.loadIcons,
			resetWorkspaceConfig: s.reset,
			scriptaDirReady: s.scriptaDirReady,
			setScriptaDirReady: s.setScriptaDirReady,
			workspaceInitialized: s.workspaceInitialized,
			configLoaded: s.configLoaded,
			setWorkspaceInitialized: s.setWorkspaceInitialized,
		})),
	);

	const { hydrateGitSync, gitAction, lastCommitTime, conflictFiles, offlineMode, gitReady } =
		useGitSyncStore(
			useShallow((s) => ({
				hydrateGitSync: s.hydrate,
				gitAction: s.gitAction,
				lastCommitTime: s.lastCommitTime,
				conflictFiles: s.conflictFiles,
				offlineMode: s.offlineMode,
				gitReady: s.gitReady,
			})),
		);

	const { scratchpadOpen, toggleScratchpad, setScratchpadOpen } = useScratchpadStore(
		useShallow((s) => ({
			scratchpadOpen: s.open,
			toggleScratchpad: s.toggle,
			setScratchpadOpen: s.setOpen,
		})),
	);

	const hydratePreference = useThemeStore((s) => s.hydratePreference);
	const { hydrateSettings, autoUpdateCheck, fontFamily } = useSettingsStore(
		useShallow((s) => ({
			hydrateSettings: s.hydrate,
			autoUpdateCheck: s.autoUpdateCheck,
			fontFamily: s.fontFamily,
		})),
	);

	const { manualSync } = useGitSync({ workspacePath });

	useScratchpadVolatile(workspacePath);

	const [loading, setLoading] = useState(true);

	// New windows (opened via Cmd+Shift+N) carry ?newWindow=true and should not
	// restore or persist the workspace path — only theme and sidebar are restored.
	const [isNewWindow] = useState(() =>
		new URLSearchParams(window.location.search).has("newWindow"),
	);
	const {
		dialogOpen: updateDialogOpen,
		description: updateDescription,
		dismissDialog: dismissUpdateDialog,
		openReleasePage,
		triggerManualCheck: triggerManualUpdateCheck,
		manualCheckInProgress: updateCheckInProgress,
	} = useUpdateCheck(autoUpdateCheck && !loading && !isNewWindow);
	const [setupWizardOpen, setSetupWizardOpen] = useState(false);
	const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [exportOpen, setExportOpen] = useState(false);
	const [exportTarget, setExportTarget] = useState<{
		markdown: string;
		filePath: string;
	} | null>(null);
	const exportRequestIdRef = useRef(0);
	const [slideViewActive, setSlideViewActive] = useState(false);
	const [slideShow, setSlideShow] = useState<{
		slides: SlideSection[];
		startIndex: number;
		themeOverride: SlideTheme | null;
	} | null>(null);
	const [goToLineOpen, setGoToLineOpen] = useState(false);
	const [searchBarOpen, setSearchBarOpen] = useState(false);
	const [searchBarExpanded, setSearchBarExpanded] = useState(false);
	const [searchBarInitialText, setSearchBarInitialText] = useState("");
	const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("files");
	const [sidebarVisible, setSidebarVisible] = useState(true);
	const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null);
	const [goToLine, setGoToLine] = useState<GoToLine>(null);
	const editorViewRef = useRef<EditorView | null>(null);
	const [editorView, setEditorView] = useState<EditorView | null>(null);
	const scratchpadSaveRef = useRef<ScratchpadSaveHandle | null>(null);
	const searchBarHandleRef = useRef<SearchBarHandle | null>(null);
	const searchBarOpenRef = useRef(false);
	searchBarOpenRef.current = searchBarOpen;
	const searchInputRef = useRef<HTMLInputElement | null>(null);

	// タブ切替の起点で AppLayout 側の一時状態をクリアする
	// (エディタ本文・エラー表示は useTabContentManager 側が持つ)。
	const handleTabSwitch = useCallback(() => {
		setCursorInfo(null);
	}, []);

	const {
		loadedDoc,
		editorKey,
		editorViewEpoch,
		isNewTab,
		editorError,
		saveStatus,
		markdownEditorHandleRef,
		getContent,
		saveNow,
		scheduleAutoSave,
		getLastSavedContent,
		saveIfDirty,
		handleCloseTab,
		handleFileRenamed,
		handleFileDeleted,
		saveAllTabs,
		getCachedContent,
		queueGoToLine,
		applyCacheReload,
		applyActiveReload,
		applyConflictReload,
		dropTab,
		isCachedTabClean,
	} = useTabContentManager({
		editorViewRef,
		onTabSwitch: handleTabSwitch,
		onGoToLine: setGoToLine,
	});

	// Load persisted settings on mount
	useEffect(() => {
		let cancelled = false;

		void (async () => {
			const settings = await loadSettings();
			if (cancelled) return;

			if (!isNewWindow && settings.workspacePath) {
				let registeredOnMain = false;
				try {
					await workspaceSet(settings.workspacePath);
					registeredOnMain = true;
					if (cancelled) return;
					await listDirectory(settings.workspacePath);
					if (cancelled) return;
					setWorkspacePath(settings.workspacePath);
				} catch {
					// 段階別ハンドリング：
					// - workspaceSet 自体の失敗（settings 永続化失敗・未承認扱い等）→
					//   main 側 state は atomic で変化していないので、保存済み workspacePath を
					//   削除してはいけない。何もしない
					// - workspaceSet 成功後の listDirectory 失敗（パス消失・権限喪失等）→
					//   main 側に登録済みなので fail-closed の整合性のため巻き戻す
					// 加えて unmount / window close 後（cancelled）はロールバックしない
					// （ユーザーの保存済み workspacePath を意図せず削除する副作用を防ぐ）
					if (cancelled) return;
					if (registeredOnMain) {
						await workspaceSet(null).catch(() => {});
					}
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
				showLinkCards: settings.showLinkCards,
				loadRemoteImages: settings.loadRemoteImages,
				scratchpadVolatile: settings.scratchpadVolatile,
				autoUpdateCheck: settings.autoUpdateCheck,
				fileTreeShowHidden: settings.fileTreeShowHidden,
				fileTreeExcludePatterns: settings.fileTreeExcludePatterns,
				slidePreviewWidthRatio: settings.slidePreviewWidthRatio,
				slideThumbnailsVisible: settings.slideThumbnailsVisible,
			});
			hydrateGitSync({
				gitSyncEnabled: settings.gitSyncEnabled,
				autoCommitInterval: settings.autoCommitInterval,
				autoPullInterval: settings.autoPullInterval,
				autoPushInterval: settings.autoPushInterval,
				pullBeforePush: settings.pullBeforePush,
				syncMethod: settings.syncMethod,
				commitMessage: settings.commitMessage,
				autoPullOnStartup: settings.autoPullOnStartup,
			});
			setSidebarVisible(settings.sidebarVisible);
			clearWebviewBrowsingData().catch((e) => console.warn("clearWebviewBrowsingData:", e));
			setLoading(false);
		})();

		return () => {
			cancelled = true;
		};
	}, [isNewWindow, setWorkspacePath, hydratePreference, hydrateSettings, hydrateGitSync]);

	// Sync editor font-family to CSS custom property
	useEffect(() => {
		document.documentElement.style.setProperty("--editor-font-family", FONT_FAMILY_MAP[fontFamily]);
	}, [fontFamily]);

	// workspacePath の永続化は main 側 workspace:set ハンドラが担うため、
	// renderer 側で settings:set を呼ぶ必要はない（settings の workspacePath は
	// reserved key として renderer からの書き込みを拒否する）。

	// Persist sidebar visibility changes (skip while loading to avoid writing back restored values)
	useEffect(() => {
		if (loading) return;
		void saveSetting("sidebarVisible", sidebarVisible);
	}, [sidebarVisible, loading]);

	// Open new tab when workspace has no tabs (startup and workspace switch)
	useEffect(() => {
		if (loading) return;
		if (workspacePath && useWorkspaceStore.getState().tabs.length === 0) {
			openNewTab();
		}
	}, [loading, workspacePath, openNewTab]);

	// Load workspace config (icons) when workspace changes
	useEffect(() => {
		if (workspacePath) {
			void loadIcons(workspacePath);
		} else {
			resetWorkspaceConfig();
		}
	}, [workspacePath, loadIcons, resetWorkspaceConfig]);

	// Reset wikilink store and run initial scan on workspace change
	useEffect(() => {
		if (workspacePath) {
			useWikilinkStore.getState().reset();
			void useWikilinkStore.getState().scan(workspacePath);
		} else {
			useWikilinkStore.getState().reset();
		}
	}, [workspacePath]);

	// Reset backlink store on workspace change (initial scan は BacklinkPanel の
	// mount 時に target = activeTabPath が確定してから走る)。
	useEffect(() => {
		// workspacePath を依存に含めるが effect 本体で使わないため明示参照する
		// (useWikilinkStore 側の effect と同じパターン)。
		void workspacePath;
		useBacklinkStore.getState().reset();
	}, [workspacePath]);

	// Open (or re-focus) the conflict resolution window
	const openConflictResolver = useCallback(async () => {
		if (!workspacePath) return;
		try {
			await openConflictWindow(workspacePath);
		} catch (err) {
			// 呼び出し元は fire-and-forget（auto-open の useEffect / StatusBar の onClick）
			// のため、ここで握って通知しないと失敗がユーザーに見えない
			useToastStore
				.getState()
				.addToast("error", `コンフリクト解決ウィンドウを開けませんでした: ${translateError(err)}`);
		}
	}, [workspacePath]);

	// Auto-open conflict resolution window only on 0 → >0 transition
	const prevConflictCountRef = useRef(0);
	useEffect(() => {
		const prev = prevConflictCountRef.current;
		prevConflictCountRef.current = conflictFiles.length;
		if (prev === 0 && conflictFiles.length > 0 && workspacePath) {
			void openConflictResolver();
		}
	}, [conflictFiles, workspacePath, openConflictResolver]);

	// Show setup wizard for uninitialized workspaces.
	// configLoaded が true かつ workspaceInitialized が false のときだけ開く。
	// ワークスペース切り替え時は loadIcons() が configLoaded をリセットするので
	// 一度閉じてから新しい結果で再評価される。
	useEffect(() => {
		if (workspacePath && configLoaded && !workspaceInitialized) {
			setSetupWizardOpen(true);
		} else {
			setSetupWizardOpen(false);
		}
	}, [workspacePath, configLoaded, workspaceInitialized]);

	const handleExport = useCallback(
		(path: string) => {
			// Prefer in-memory content so unsaved edits are included
			const cached = getCachedContent(path);
			if (cached !== null) {
				setExportTarget({ markdown: cached, filePath: path });
				setExportOpen(true);
				return;
			}
			// File not open in any tab — read from disk.
			// Track request ID so only the latest readFile response takes effect.
			const requestId = ++exportRequestIdRef.current;
			readFile(path)
				.then((markdown) => {
					if (exportRequestIdRef.current !== requestId) return;
					setExportTarget({ markdown, filePath: path });
					setExportOpen(true);
				})
				.catch((err) => {
					if (exportRequestIdRef.current !== requestId) return;
					useToastStore
						.getState()
						.addToast(
							"error",
							`エクスポート用のファイル読み込みに失敗しました: ${translateError(err)}`,
						);
				});
		},
		[getCachedContent],
	);

	// Listen for native menu events
	useEffect(() => {
		const unlisteners: Array<() => void> = [];
		unlisteners.push(onMenuEvent("open-settings", () => setSettingsOpen(true)));
		unlisteners.push(onMenuEvent("open-help", () => setHelpOpen(true)));
		unlisteners.push(
			onMenuEvent("export", () => {
				const path = useWorkspaceStore.getState().activeTabPath;
				if (!path || isNewTabPath(path)) return;
				handleExport(path);
			}),
		);
		return () => {
			for (const u of unlisteners) u();
		};
	}, [handleExport]);

	// Save all dirty tabs before window closes
	useEffect(() => {
		let cancelled = false;
		const unlisten = onWindowCloseRequested(async () => {
			// active タブと dirty な cache タブの保存は useTabContentManager が担う。
			// "cancelled" は unmount 済みで続行を打ち切ったことを表し、close は妨げない。
			const result = await saveAllTabs();
			if (cancelled || result === "cancelled") return;

			// Throwing here causes preload to ack false → main aborts window close,
			// keeping the user's unsaved work intact.
			if (result === "failed") throw new Error("Failed to save one or more dirty tabs");

			// Save scratchpad (ref survives panel unmount)
			if (scratchpadSaveRef.current) {
				const scratchpadSaved = await scratchpadSaveRef.current();
				if (cancelled) return;
				if (!scratchpadSaved) throw new Error("Failed to save scratchpad");
			}
		});

		return () => {
			cancelled = true;
			unlisten();
		};
	}, [saveAllTabs]);

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
				dropTab(path);
				closeTab(path);
			}
		},
		[closeTab, dropTab],
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
							applyCacheReload(path, loaded);
							applyActiveReload(path, loaded);
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
				if (isCachedTabClean(path)) {
					readFile(path)
						.then((loaded) => {
							applyCacheReload(path, loaded);
						})
						.catch((err) => {
							console.error("Failed to reload cached file:", err);
						});
				}
			}
		},
		[applyCacheReload, applyActiveReload, isCachedTabClean],
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
				applyConflictReload(path, loaded);
			})
			.catch((err) => {
				console.error("Failed to reload file on conflict resolve:", err);
				// File may have been deleted — notify user via the deleted dialog
				setExternalConflict({ path, type: "deleted" });
			});
	}, [externalConflict, applyConflictReload]);

	const handleConflictKeep = useCallback(() => {
		setExternalConflict(null);
	}, []);

	const handleDeletedDirtyDiscard = useCallback(() => {
		if (externalConflict?.type !== "deleted") return;
		const path = externalConflict.path;
		setExternalConflict(null);
		dropTab(path);
		closeTab(path);
	}, [externalConflict, closeTab, dropTab]);

	const handleDeletedDirtyKeep = useCallback(() => {
		setExternalConflict(null);
	}, []);

	const handleEditorView = useCallback((view: EditorView | null) => {
		editorViewRef.current = view;
		setEditorView(view);
	}, []);

	// newtab ページ上でファイルを開く共通処理。
	// navigateInTab に委譲する。未オープンのファイルは newtab を置き換え、
	// 既にオープン済みのファイルはそのタブへ切り替える（newtab は残る）。
	// newtab の重複は openNewTab 側で防いでいるため溜まらない。
	const openFileFromNewTab = useCallback(
		(filePath: string) => {
			navigateInTab(filePath);
		},
		[navigateInTab],
	);

	// Navigation handlers
	const handleFileSelect = useCallback(
		async (path: string) => {
			// Save current file before navigating if dirty
			if (activeTabPath && !(await saveIfDirty())) return;
			const state = useWorkspaceStore.getState();
			if (state.activeTabPath && isNewTabPath(state.activeTabPath)) {
				openFileFromNewTab(path);
			} else {
				navigateInTab(path);
			}
		},
		[activeTabPath, navigateInTab, openFileFromNewTab, saveIfDirty],
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
		if (activeTabPath && !(await saveIfDirty())) return;
		goBackInTab();
	}, [activeTabPath, goBackInTab, saveIfDirty]);

	const handleGoForward = useCallback(async () => {
		// Save current file before navigating if dirty
		if (activeTabPath && !(await saveIfDirty())) return;
		goForwardInTab();
	}, [activeTabPath, goForwardInTab, saveIfDirty]);

	const handleCommandPaletteSelect = useCallback(
		(filePath: string) => {
			// newtab ページ上では openFileFromNewTab で処理
			const state = useWorkspaceStore.getState();
			if (state.activeTabPath && isNewTabPath(state.activeTabPath)) {
				openFileFromNewTab(filePath);
			} else {
				openTab(filePath);
			}
		},
		[openTab, openFileFromNewTab],
	);

	const handleShowFiles = useCallback(() => {
		setSidebarPanel("files");
	}, []);

	const handleShowSearch = useCallback(() => {
		setSidebarPanel("search");
		requestAnimationFrame(() => {
			searchInputRef.current?.focus();
		});
	}, []);

	const handleShowUnresolved = useCallback(() => {
		setSidebarPanel("unresolved");
	}, []);

	const handleShowBacklink = useCallback(() => {
		setSidebarPanel("backlink");
	}, []);

	const handleSearchNavigate = useCallback(
		(
			filePath: string,
			lineNumber: number,
			query: string,
			matchStart?: number,
			matchEnd?: number,
		) => {
			const state = useWorkspaceStore.getState();
			const target: GoToLineRequest =
				matchStart != null && matchEnd != null
					? { line: lineNumber, query, columnStart: matchStart, columnEnd: matchEnd }
					: { line: lineNumber, query };
			if (state.activeTabPath === filePath) {
				setGoToLine(target);
			} else {
				queueGoToLine(target);
				if (state.activeTabPath && isNewTabPath(state.activeTabPath)) {
					openFileFromNewTab(filePath);
				} else {
					openTab(filePath);
				}
			}
		},
		[openTab, openFileFromNewTab, queueGoToLine],
	);

	const handleGoToLineDone = useCallback(() => {
		setGoToLine(null);
	}, []);

	const handleStatistics = useCallback((info: CursorInfo) => {
		setCursorInfo(info);
	}, []);

	const handleSave = useCallback(() => {
		void saveNow();
	}, [saveNow]);

	// CodeMirror が docChanged を通知するたびに呼ばれる (#302)。
	// dirty フラグは下の "Sync dirty flag to store" effect が saveStatus 変化を起点に
	// set するため、ここでは触らない (同じ意図の実装を 2 箇所に持たないため)。
	const handleDocChanged = scheduleAutoSave;

	// Close search bar when switching to non-file tab, close go-to-line on any tab switch,
	// reset slide view on tab switch
	useEffect(() => {
		setGoToLineOpen(false);
		setSlideViewActive(false);
		setSlideShow(null);
		if (!activeTabPath || isNewTabPath(activeTabPath)) {
			setSearchBarOpen(false);
		}
	}, [activeTabPath]);

	// F5 で発表モードを開く。SlideView と独立に、通常エディタからも起動できる。
	// slides を snapshot して overlay に渡す (mount 中 markdown 変更を反映しない仕様)。
	const startSlideShow = useCallback(() => {
		const path = useWorkspaceStore.getState().activeTabPath;
		if (!path || isNewTabPath(path)) return;
		const view = editorViewRef.current;
		const content = getContent();
		const slides = parseSlides(content);
		const startIndex = findSlideAtCursor(slides, view?.state.selection.main.head ?? 0);
		// Fable #12: F5 押下時に frontmatter theme も snapshot する。overlay mount 中は
		// markdown 変更を反映しないので snapshot 契約と揃える。
		const themeOverride = extractSlideFrontmatterTheme(content);
		setSlideShow({ slides, startIndex, themeOverride });
	}, [getContent]);

	// overlay の keydown effect が deps 差分で毎レンダー再購読しないよう identity を安定化。
	const closeSlideShow = useCallback(() => setSlideShow(null), []);

	useShortcuts(
		buildAppShortcuts({
			activatePrevTab,
			activateNextTab,
			handleGoBack,
			handleGoForward,
			activeTabId,
			handleCloseTab,
			setSidebarVisible,
			setSidebarPanel,
			setSlideViewActive,
			handleExport,
			searchInputRef,
			editorViewRef,
			searchBarOpenRef,
			searchBarHandleRef,
			setSearchBarExpanded,
			setSearchBarInitialText,
			setSearchBarOpen,
			workspacePath,
			openNewTab,
			toggleScratchpad,
			setGoToLineOpen,
			setCommandPaletteOpen,
			setSettingsOpen,
			setHelpOpen,
			slideShowOpen: slideShow !== null,
			commandPaletteOpen,
			settingsOpen,
			helpOpen,
			exportOpen,
			startSlideShow,
		}),
	);

	if (loading) {
		return <div className="flex h-screen flex-col bg-bg-primary text-text-primary" />;
	}

	const editorProps = {
		value: loadedDoc,
		onDocChanged: handleDocChanged,
		onSave: handleSave,
		onEditorView: handleEditorView,
		goToLine,
		onGoToLineDone: handleGoToLineDone,
		onStatistics: handleStatistics,
	};

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
				<div
					className={`sidebar-wrapper shrink-0 overflow-hidden ${sidebarVisible ? "w-60 border-r border-border" : "w-0 invisible"}`}
				>
					<Sidebar
						activePanel={sidebarPanel}
						onShowFiles={handleShowFiles}
						onShowSearch={handleShowSearch}
						onShowUnresolved={handleShowUnresolved}
						onShowBacklink={handleShowBacklink}
						onSearchNavigate={handleSearchNavigate}
						onFileSelect={handleFileSelect}
						onFileOpenNewTab={handleFileOpenNewTab}
						searchInputRef={searchInputRef}
						onFileRenamed={handleFileRenamed}
						onFileDeleted={handleFileDeleted}
						onExport={handleExport}
					/>
				</div>
				<main className="relative min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden">
					{activeTabPath && !isNewTab ? (
						editorError ? (
							<div className="editor-error">
								<p>{editorError}</p>
							</div>
						) : slideViewActive ? (
							<SlideView key={editorKey} {...editorProps} />
						) : (
							<MarkdownEditor
								key={editorKey}
								{...editorProps}
								snapshotHandleRef={markdownEditorHandleRef}
							/>
						)
					) : (
						<NewTabContent
							hasWorkspace={!!workspacePath}
							onAction={(action) => {
								if (action === "commandPalette") setCommandPaletteOpen(true);
								if (action === "workspaceSearch") {
									setSidebarPanel("search");
									requestAnimationFrame(() => searchInputRef.current?.focus());
								}
								if (action === "help") setHelpOpen(true);
							}}
						/>
					)}
					{scratchpadOpen && workspacePath && (
						<ScratchpadPanel
							workspacePath={workspacePath}
							onClose={() => setScratchpadOpen(false)}
							saveRef={scratchpadSaveRef}
						/>
					)}
					{searchBarOpen && editorView && (
						<SearchBar
							view={editorView}
							viewEpoch={editorViewEpoch}
							onClose={() => setSearchBarOpen(false)}
							initialExpanded={searchBarExpanded}
							initialSearchText={searchBarInitialText}
							handleRef={searchBarHandleRef}
						/>
					)}
					<GoToLineDialog
						open={goToLineOpen}
						totalLines={editorView?.state.doc.lines ?? 0}
						onGoToLine={(line) => setGoToLine({ line })}
						onClose={() => setGoToLineOpen(false)}
					/>
				</main>
			</div>
			<StatusBar
				saveStatus={activeTabPath && !isNewTab ? saveStatus : undefined}
				cursorInfo={
					activeTabPath && !isNewTab && !editorError ? (cursorInfo ?? undefined) : undefined
				}
				filePath={
					activeTabPath && !isNewTab
						? ((workspacePath
								? activeTabPath.replace(addTrailingSep(workspacePath), "")
								: activeTabPath) ?? undefined)
						: undefined
				}
				onOpenSettings={() => setSettingsOpen(true)}
				onOpenHelp={() => setHelpOpen(true)}
				gitAction={gitAction}
				lastCommitTime={lastCommitTime}
				hasConflicts={conflictFiles.length > 0}
				offlineMode={offlineMode}
				onGitSync={manualSync}
				onOpenConflictResolver={openConflictResolver}
				gitReady={gitReady}
				onToggleSlideView={
					activeTabPath && !isNewTab && !editorError
						? () => setSlideViewActive((prev) => !prev)
						: undefined
				}
				slideViewActive={slideViewActive}
				onToggleScratchpad={workspacePath ? toggleScratchpad : undefined}
				scratchpadOpen={scratchpadOpen}
				onToggleSidebar={() => setSidebarVisible((prev) => !prev)}
				sidebarVisible={sidebarVisible}
			/>

			{workspacePath && (
				<CommandPalette
					open={commandPaletteOpen}
					workspacePath={workspacePath}
					onSelect={handleCommandPaletteSelect}
					onClose={() => setCommandPaletteOpen(false)}
				/>
			)}

			<SettingsDialog
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				workspacePath={workspacePath}
				onOpenFile={openTab}
				onManualSync={manualSync}
				onCheckForUpdate={() => void triggerManualUpdateCheck()}
				updateCheckInProgress={updateCheckInProgress}
			/>
			<HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
			{exportTarget && (
				<ExportDialog
					open={exportOpen}
					onClose={() => setExportOpen(false)}
					markdown={exportTarget.markdown}
					filePath={exportTarget.filePath}
					workspacePath={workspacePath}
					onOpenFile={openTab}
					scriptaDirReady={scriptaDirReady}
					onScriptaDirConfirm={() => setScriptaDirReady(true)}
				/>
			)}
			{workspacePath && (
				<SetupWizardDialog
					open={setupWizardOpen}
					onClose={() => setSetupWizardOpen(false)}
					workspacePath={workspacePath}
					onComplete={() => {
						// ワークスペース切替中に古い非同期処理が完了した場合を防ぐ
						if (useWorkspaceStore.getState().workspacePath !== workspacePath) return;
						setScriptaDirReady(true);
						setWorkspaceInitialized(true);
						bumpFileTreeVersion();
					}}
				/>
			)}
			{workspacePath && <DirectoryPickerDialog workspacePath={workspacePath} />}
			<ToastContainer />
			{slideShow && (
				<Suspense fallback={null}>
					<SlideShowOverlay
						slides={slideShow.slides}
						startIndex={slideShow.startIndex}
						themeOverride={slideShow.themeOverride}
						onClose={closeSlideShow}
					/>
				</Suspense>
			)}
			<Dialog
				open={updateDialogOpen}
				title="アップデートのお知らせ"
				description={updateDescription}
				confirmLabel="ダウンロードページを開く"
				cancelLabel="後で"
				onConfirm={openReleasePage}
				onCancel={dismissUpdateDialog}
			/>

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
