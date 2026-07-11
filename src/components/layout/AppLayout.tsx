import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAutoSave } from "../../hooks/useAutoSave";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { useGitSync } from "../../hooks/useGitSync";
import { useScratchpadVolatile } from "../../hooks/useScratchpadVolatile";
import { useUpdateCheck } from "../../hooks/useUpdateCheck";
import {
	clearWebviewBrowsingData,
	closeWindow,
	listDirectory,
	onMenuEvent,
	onWindowCloseRequested,
	openConflictWindow,
	readFile,
	workspaceSet,
	writeFile,
} from "../../lib/commands";
import { processContent } from "../../lib/content";
import { translateError } from "../../lib/errors";
import { addTrailingSep, basename, isNewTabPath, replacePrefix } from "../../lib/path";
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
import { Dialog } from "../common/Dialog";
import { DirectoryPickerDialog } from "../common/DirectoryPickerDialog";
import { ExportDialog } from "../common/ExportDialog";
import { HelpDialog } from "../common/HelpDialog";
import { SettingsDialog } from "../common/SettingsDialog";
import { SetupWizardDialog } from "../common/SetupWizardDialog";
import { ToastContainer } from "../common/Toast";
import { FONT_FAMILY_MAP } from "../editor/editor-theme";
import type { CursorInfo, GoToLineRequest, MarkdownEditorHandle } from "../editor/MarkdownEditor";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import { ScratchpadPanel, type ScratchpadSaveHandle } from "../editor/ScratchpadPanel";
import { TabBar } from "../editor/TabBar";
import { CommandPalette } from "../search/CommandPalette";
import { GoToLineDialog } from "../search/GoToLineDialog";
import { SearchBar, type SearchBarHandle } from "../search/SearchBar";
import { SlideView } from "../slide/SlideView";
import { NewTabContent } from "./NewTabContent";
import { Sidebar, type SidebarPanel } from "./Sidebar";
import { StatusBar } from "./StatusBar";

type GoToLine = GoToLineRequest | null;

interface TabCache {
	content: string;
	savedContent: string;
	// MarkdownEditorHandle.captureSnapshot() で取得した EditorState の JSON 表現 (#220)。
	// historyField のみを抽出するため、SearchBar 等が view に append した一時 extension
	// (検索ハイライト・listener) は含まれない。タブ切替で復元しても汚染なし。
	// 復元時は最新の extensions で EditorState を組み立て直すので、設定変更後も古い構成が戻らない。
	editorStateSnapshot?: unknown;
}

export function AppLayout() {
	const {
		activeTabPath,
		activeTabId,
		workspacePath,
		setWorkspacePath,
		closeTab,
		closeTabById,
		setActiveTabById,
		setTabDirty,
		renameTab,
		openTab,
		navigateInTab,
		goBackInTab,
		goForwardInTab,
		closeTabsByPrefix,
		renameTabsByPrefix,
		reorderTab,
		openNewTab,
		activateNextTab,
		activatePrevTab,
		bumpFileTreeVersion,
		bumpContentVersion,
	} = useWorkspaceStore(
		useShallow((s) => ({
			activeTabPath: s.activeTabPath,
			activeTabId: s.activeTabId,
			workspacePath: s.workspacePath,
			setWorkspacePath: s.setWorkspacePath,
			closeTab: s.closeTab,
			closeTabById: s.closeTabById,
			setActiveTabById: s.setActiveTabById,
			setTabDirty: s.setTabDirty,
			renameTab: s.renameTab,
			openTab: s.openTab,
			navigateInTab: s.navigateInTab,
			goBackInTab: s.goBackInTab,
			goForwardInTab: s.goForwardInTab,
			closeTabsByPrefix: s.closeTabsByPrefix,
			renameTabsByPrefix: s.renameTabsByPrefix,
			reorderTab: s.reorderTab,
			openNewTab: s.openNewTab,
			activateNextTab: s.activateNextTab,
			activatePrevTab: s.activatePrevTab,
			bumpFileTreeVersion: s.bumpFileTreeVersion,
			bumpContentVersion: s.bumpContentVersion,
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
	const [goToLineOpen, setGoToLineOpen] = useState(false);
	const [searchBarOpen, setSearchBarOpen] = useState(false);
	const [searchBarExpanded, setSearchBarExpanded] = useState(false);
	const [searchBarInitialText, setSearchBarInitialText] = useState("");
	const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>("files");
	const [sidebarVisible, setSidebarVisible] = useState(true);
	const [cursorInfo, setCursorInfo] = useState<CursorInfo | null>(null);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [goToLine, setGoToLine] = useState<GoToLine>(null);
	const editorViewRef = useRef<EditorView | null>(null);
	const [editorView, setEditorView] = useState<EditorView | null>(null);
	// view.setState() で内部 state が完全置換されると view identity は変わらないため、
	// view を直接 deps に持つ SearchBar などの effect が再実行されない。epoch を increment
	// して prop 経由で伝えることで、view 同一でも下流の effect を強制的に再走させる (#220)。
	const [editorViewEpoch, setEditorViewEpoch] = useState(0);
	const scratchpadSaveRef = useRef<ScratchpadSaveHandle | null>(null);
	const searchBarHandleRef = useRef<SearchBarHandle | null>(null);
	const searchBarOpenRef = useRef(false);
	searchBarOpenRef.current = searchBarOpen;
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const pendingGoToLineRef = useRef<GoToLineRequest | null>(null);

	// 本文を React state から外し、controlled CodeMirror の per-keystroke 全文再レンダーを
	// 避ける (#302)。loadedDoc はロード/タブ切替/外部リロード時のみ変わり、CodeMirror の
	// `value` にはこれを渡す。keystroke 毎の最新本文は editorViewRef 経由で直接読む。
	const [loadedDoc, setLoadedDoc] = useState("");
	const loadedDocRef = useRef(loadedDoc);
	loadedDocRef.current = loadedDoc;
	const getContent = useCallback(
		() => editorViewRef.current?.state.doc.toString() ?? loadedDocRef.current,
		[],
	);
	const [editorKey, setEditorKey] = useState(0);
	const isNewTab = activeTabPath ? isNewTabPath(activeTabPath) : false;
	const isEditorComposing = useCallback(() => editorViewRef.current?.composing ?? false, []);
	const tabCacheRef = useRef(new Map<string, TabCache>());
	// MarkdownEditor の snapshot handle (captureSnapshot / restoreSnapshot) への参照 (#220)。
	const markdownEditorHandleRef = useRef<MarkdownEditorHandle | null>(null);

	// file watcher イベントで cache を disk loaded 内容に更新するときの共通処理 (#220)。
	// loaded が processContent 適用後の existing.content と一致 = 自分の write
	// (タブ切替時 flush save 等) なら cache は既に正しいので **何もしない**。
	// cache.content/savedContent を loaded (整形後) に上書きすると、保持している
	// snapshot 内 doc (生のまま) とズレてしまい、復元時に表示・dirty 判定・undo が壊れる。
	// 一致しない = 外部書き換え → cache を全置換 + editorStateSnapshot 破棄
	// (history を保持しても doc とズレるため)。
	const setCacheFromReload = useCallback((path: string, loaded: string) => {
		const existing = tabCacheRef.current.get(path);
		const trim = useSettingsStore.getState().trimTrailingWhitespace;
		if (existing && loaded === processContent(existing.content, trim)) {
			return;
		}
		tabCacheRef.current.set(path, {
			content: loaded,
			savedContent: loaded,
			editorStateSnapshot: undefined,
		});
	}, []);

	const handleFlushComplete = useCallback(
		(path: string, rawContent: string) => {
			const cached = tabCacheRef.current.get(path);
			if (cached) {
				cached.savedContent = rawContent;
			}
			// flush 対象タブが現在アクティブで、かつ flush 後にさらに編集されていた場合は
			// dirty をクリアしない（ユーザーの編集が未保存のまま残っている）
			const currentActive = useWorkspaceStore.getState().activeTabPath;
			if (currentActive === path && getContent() !== rawContent) {
				return;
			}
			setTabDirty(path, false);
		},
		[setTabDirty, getContent],
	);
	const { saveStatus, saveNow, markSaved, waitForPending, getLastSavedContent, scheduleAutoSave } =
		useAutoSave(
			isNewTab ? "" : (activeTabPath ?? ""),
			getContent,
			isEditorComposing,
			handleFlushComplete,
		);
	const prevTabPathRef = useRef<string | null>(null);
	const contentLoadedForPathRef = useRef<string | null>(null);
	const savedContentRef = useRef("");
	const saveNowRef = useRef(saveNow);
	saveNowRef.current = saveNow;
	const prevWorkspacePathRef = useRef(workspacePath);
	const justSwitchedRef = useRef(false);

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
				scratchpadVolatile: settings.scratchpadVolatile,
				autoUpdateCheck: settings.autoUpdateCheck,
				fileTreeShowHidden: settings.fileTreeShowHidden,
				fileTreeExcludePatterns: settings.fileTreeExcludePatterns,
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
			const state = useWorkspaceStore.getState();
			if (path === state.activeTabPath) {
				setExportTarget({ markdown: getContent(), filePath: path });
				setExportOpen(true);
				return;
			}
			const cached = tabCacheRef.current.get(path);
			if (cached) {
				setExportTarget({ markdown: cached.content, filePath: path });
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
		[getContent],
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
			let hasFailed = false;
			const currentActiveTab = useWorkspaceStore.getState().activeTabPath;
			const { trimTrailingWhitespace } = useSettingsStore.getState();

			// Save active tab if dirty (skip new-tab pages)
			if (
				currentActiveTab &&
				!isNewTabPath(currentActiveTab) &&
				getContent() !== savedContentRef.current
			) {
				const saved = await saveNowRef.current();
				if (cancelled) return;
				if (!saved) hasFailed = true;
			}

			// Save all dirty cached non-active tabs with content normalization
			const saves: Promise<{ path: string; ok: boolean; content: string }>[] = [];
			for (const [path, cached] of tabCacheRef.current) {
				if (
					path !== currentActiveTab &&
					!isNewTabPath(path) &&
					cached.content !== cached.savedContent
				) {
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

			// Throwing here causes preload to ack false → main aborts window close,
			// keeping the user's unsaved work intact.
			if (hasFailed) throw new Error("Failed to save one or more dirty tabs");

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
	}, [setTabDirty, getContent]);

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
		// and the tab still exists — navigateInTab may change the tab's path).
		// Skip new-tab pages — they have no file content to cache.
		if (
			!workspaceChanged &&
			prevPath &&
			!isNewTabPath(prevPath) &&
			contentLoadedForPathRef.current === prevPath
		) {
			const tabStillExists = useWorkspaceStore
				.getState()
				.tabs.some((t) => t.path === prevPath || t.history.includes(prevPath));
			if (tabStillExists) {
				const currentCache = tabCacheRef.current.get(prevPath);
				// MarkdownEditorHandle.captureSnapshot() で historyField を含む JSON snapshot を
				// 取得する (#220)。snapshot は historyField のみを抽出するため、SearchBar が
				// view に append した検索 compartment や、検索 query 等の一時 extension は
				// 含まれない (= 別タブから戻っても汚染なし、検索バー開放中の編集でも履歴維持)。
				const prevSnapshot = markdownEditorHandleRef.current?.captureSnapshot();
				tabCacheRef.current.set(prevPath, {
					content: getContent(),
					savedContent: currentCache?.savedContent ?? savedContentRef.current,
					editorStateSnapshot: prevSnapshot ?? currentCache?.editorStateSnapshot,
				});
			} else {
				tabCacheRef.current.delete(prevPath);
			}
		}

		prevTabPathRef.current = activeTabPath;
		justSwitchedRef.current = true;

		if (!activeTabPath) {
			contentLoadedForPathRef.current = null;
			setLoadedDoc("");
			savedContentRef.current = "";
			markSaved("");
			return;
		}

		// New-tab page — no editor, no content to load
		if (isNewTabPath(activeTabPath)) {
			contentLoadedForPathRef.current = null;
			setLoadedDoc("");
			savedContentRef.current = "";
			markSaved("");
			return;
		}

		const cached = tabCacheRef.current.get(activeTabPath);
		if (cached) {
			contentLoadedForPathRef.current = activeTabPath;
			savedContentRef.current = cached.savedContent;
			// キャッシュに未保存編集が残っていた場合 (flush 失敗 / IME defer で
			// savedContent が stale) は dirty 状態を復元する必要がある。
			// setLoadedDoc + restoreSnapshot/remount のいずれも updateListener の
			// docChanged を発火しないため、markSaved 側で content 差分を検知させる (#302 fix)。
			markSaved(cached.savedContent, cached.content);
			setLoadedDoc(cached.content);
			// editorStateSnapshot が保存されていれば最新の extensions で組み立て直して
			// undo/redo 履歴ごと復元する (#220)。失敗条件 (どれかでも該当):
			// - handle 未取得 (SlideView 表示中など MarkdownEditor が mount されていない)
			// - editorStateSnapshot なし (初回 / 外部書き換え後)
			// - restoreSnapshot が false を返した (JSON 構造が不正など)
			// 失敗時は remount で view を作り直して新 content で初期化する fallback。
			const handle = markdownEditorHandleRef.current;
			const restored =
				cached.editorStateSnapshot != null && handle
					? handle.restoreSnapshot(cached.editorStateSnapshot)
					: false;
			if (restored) {
				// view identity は同じだが内部 state は完全置換されたので、view を deps に
				// 持つ下流の effect (SearchBar 等) を強制的に再走させるために epoch を bump (#220)。
				// cursor info は restoreSnapshot 内で onStatistics 経由で通知済み。
				setEditorViewEpoch((e) => e + 1);
			} else {
				setEditorKey((k) => k + 1);
			}
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
				setLoadedDoc(loaded);
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
				setLoadedDoc("");
				pendingGoToLineRef.current = null;
			});
		return () => {
			ignore = true;
		};
	}, [activeTabPath, workspacePath, markSaved, getContent]);

	// Keep savedContent in cache and ref in sync when save completes.
	// Guard with contentLoadedForPathRef to avoid misattributing a flush save
	// (for the previous file) as a save for the current activeTabPath.
	// Also skip when just switched tabs — the editor still has the old tab's content.
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
			const current = getContent();
			savedContentRef.current = current;
			const cached = tabCacheRef.current.get(activeTabPath);
			if (cached) {
				cached.savedContent = current;
			}
			bumpContentVersion();
		}
	}, [activeTabPath, saveStatus, bumpContentVersion, getContent]);

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
							setCacheFromReload(path, loaded);
							// Only update editor state if this file is still the active tab
							if (useWorkspaceStore.getState().activeTabPath !== path) return;
							// Compare with last written content (processed) to detect our own saves
							if (loaded === getLastSavedContentRef.current()) return;
							savedContentRef.current = loaded;
							markSaved(loaded);
							setLoadedDoc(loaded);
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
							setCacheFromReload(path, loaded);
						})
						.catch((err) => {
							console.error("Failed to reload cached file:", err);
						});
				}
			}
		},
		[markSaved, setCacheFromReload],
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
					setLoadedDoc(loaded);
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

	// save-before-navigate 系ハンドラで共通利用: 現在の doc が最終保存内容と異なれば
	// saveNow() で強制フラッシュ。dirty でない or 保存成功なら true、失敗なら false。
	const saveIfDirty = useCallback(async (): Promise<boolean> => {
		if (getContent() === savedContentRef.current) return true;
		return await saveNow();
	}, [getContent, saveNow]);

	const handleCloseTab = useCallback(
		async (id: number) => {
			if (closingTabsRef.current.has(id)) return;
			closingTabsRef.current.add(id);

			try {
				const state = useWorkspaceStore.getState();
				const tab = state.tabs.find((t) => t.id === id);
				if (!tab) return;
				const path = tab.path;

				// New-tab pages: close without saving
				if (isNewTabPath(path)) {
					tabCacheRef.current.delete(path);
					closeTabById(id);
					return;
				}

				if (id === state.activeTabId) {
					if (!(await saveIfDirty())) return;
					tabCacheRef.current.delete(path);
					closeTabById(id);
					return;
				}

				// Non-active tab: wait for any in-flight writes, then save from cache if dirty
				await waitForPending();

				// Re-check: tab may have become active during waitForPending
				const currentState = useWorkspaceStore.getState();
				if (id === currentState.activeTabId) {
					if (!(await saveIfDirty())) return;
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
		[closeTabById, waitForPending, saveIfDirty],
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
				pendingGoToLineRef.current = target;
				if (state.activeTabPath && isNewTabPath(state.activeTabPath)) {
					openFileFromNewTab(filePath);
				} else {
					openTab(filePath);
				}
			}
		},
		[openTab, openFileFromNewTab],
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
		if (!activeTabPath || isNewTabPath(activeTabPath)) {
			setSearchBarOpen(false);
		}
	}, [activeTabPath]);

	// Keyboard shortcuts
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			// Tab switching: Cmd+Shift+[ / Cmd+Shift+] (must be checked before non-shift variants)
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "{" || e.key === "[")) {
				e.preventDefault();
				activatePrevTab();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "}" || e.key === "]")) {
				e.preventDefault();
				activateNextTab();
				return;
			}
			// Navigation: Cmd+[ / Alt+Left = back, Cmd+] / Alt+Right = forward
			if ((e.metaKey || e.ctrlKey) && e.key === "[") {
				e.preventDefault();
				void handleGoBack();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "]") {
				e.preventDefault();
				void handleGoForward();
				return;
			}
			if (e.altKey && e.key === "ArrowLeft") {
				e.preventDefault();
				void handleGoBack();
				return;
			}
			if (e.altKey && e.key === "ArrowRight") {
				e.preventDefault();
				void handleGoForward();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
				e.preventDefault();
				if (e.shiftKey) {
					// Cmd+Shift+W: タブの有無に関わらずウィンドウを閉じる（未保存の変更は保存される）
					void closeWindow();
					return;
				}
				if (activeTabId != null) {
					void handleCloseTab(activeTabId);
				} else {
					// タブがない時はウィンドウを閉じる
					void closeWindow();
				}
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "/") {
				e.preventDefault();
				setSidebarVisible((prev) => !prev);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
				e.preventDefault();
				setSidebarPanel("files");
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
				e.preventDefault();
				const path = useWorkspaceStore.getState().activeTabPath;
				if (path && !isNewTabPath(path)) {
					setSlideViewActive((prev) => !prev);
				}
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
				e.preventDefault();
				const path = useWorkspaceStore.getState().activeTabPath;
				if (!path || isNewTabPath(path)) return;
				handleExport(path);
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "f") {
				e.preventDefault();
				setSidebarPanel("search");
				requestAnimationFrame(() => {
					searchInputRef.current?.focus();
				});
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "u") {
				e.preventDefault();
				setSidebarPanel((prev) => (prev === "unresolved" ? "files" : "unresolved"));
				return;
			}
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
				e.preventDefault();
				setSidebarPanel((prev) => (prev === "backlink" ? "files" : "backlink"));
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
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "t") {
				e.preventDefault();
				if (workspacePath) openNewTab();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "j") {
				e.preventDefault();
				if (workspacePath) toggleScratchpad();
				return;
			}
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "g") {
				const view = editorViewRef.current;
				if (view?.hasFocus) {
					e.preventDefault();
					setGoToLineOpen((prev) => !prev);
				}
				return;
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
	}, [
		activeTabId,
		activateNextTab,
		activatePrevTab,
		handleCloseTab,
		handleExport,
		handleGoBack,
		handleGoForward,
		openNewTab,
		toggleScratchpad,
		workspacePath,
	]);

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
