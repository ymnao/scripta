import type { EditorView } from "@codemirror/view";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { GoToLineRequest, MarkdownEditorHandle } from "../components/editor/MarkdownEditor";
import type { SaveStatus } from "../components/layout/StatusBar";
import { readFile, writeFile } from "../lib/commands";
import { processContent } from "../lib/content";
import { translateError } from "../lib/errors";
import { addTrailingSep, isNewTabPath, replacePrefix } from "../lib/path";
import { useSettingsStore } from "../stores/settings";
import { useWorkspaceStore } from "../stores/workspace";
import { useAutoSave } from "./useAutoSave";

interface TabCache {
	content: string;
	savedContent: string;
	// MarkdownEditorHandle.captureSnapshot() で取得した EditorState の JSON 表現 (#220)。
	// historyField のみを抽出するため、SearchBar 等が view に append した一時 extension
	// (検索ハイライト・listener) は含まれない。タブ切替で復元しても汚染なし。
	// 復元時は最新の extensions で EditorState を組み立て直すので、設定変更後も古い構成が戻らない。
	editorStateSnapshot?: unknown;
}

export interface UseTabContentManagerOptions {
	/** MarkdownEditor / SlideView が保持する CodeMirror view への参照 (AppLayout 所有)。 */
	editorViewRef: RefObject<EditorView | null>;
	/** タブ切替の起点で呼ばれる。AppLayout 側の cursorInfo 等をクリアする用途。 */
	onTabSwitch: () => void;
	/** 保留していた go-to-line 要求をエディタへ流すときに呼ばれる。 */
	onGoToLine: (request: GoToLineRequest) => void;
}

/** window close 時の一括保存の結果。cancelled は unmount 済みで続行を打ち切ったことを表す。 */
export type SaveAllTabsResult = "ok" | "failed" | "cancelled";

export interface TabContentManager {
	/** CodeMirror に渡す doc。ロード / タブ切替 / 外部リロード時のみ変わる (#302)。 */
	loadedDoc: string;
	/** インクリメントするとエディタを remount して新 content で初期化し直す。 */
	editorKey: number;
	/** view identity が同じまま内部 state が置換されたことを下流に伝える epoch (#220)。 */
	editorViewEpoch: number;
	/** activeTabPath が newtab:// ページかどうか。 */
	isNewTab: boolean;
	/** ファイル読み込みに失敗したときのメッセージ。タブ切替でクリアされる。 */
	editorError: string | null;
	saveStatus: SaveStatus;
	markdownEditorHandleRef: RefObject<MarkdownEditorHandle | null>;
	/** 未保存の編集を含む最新の本文 (view があれば view から直接読む)。 */
	getContent: () => string;
	saveNow: () => Promise<boolean>;
	scheduleAutoSave: () => void;
	/** 最後に書き込んだ (整形後の) 内容。外部変更が自分の write かの判定に使う。 */
	getLastSavedContent: () => string;
	/** dirty なら saveNow() で強制フラッシュ。dirty でない or 保存成功なら true。 */
	saveIfDirty: () => Promise<boolean>;
	handleCloseTab: (id: number) => Promise<void>;
	handleFileRenamed: (oldPath: string, newPath: string, isDirectory: boolean) => void;
	handleFileDeleted: (path: string, isDirectory: boolean) => void;
	/** window close 前に active タブと dirty な cache タブを全て保存する。 */
	saveAllTabs: () => Promise<SaveAllTabsResult>;
	/** メモリ上の最新内容 (active なら getContent、cache にあれば cache)。無ければ null。 */
	getCachedContent: (path: string) => string | null;
	/** 次にそのファイルが開かれたときに適用する go-to-line 要求を積む。 */
	queueGoToLine: (request: GoToLineRequest) => void;
	/** watcher が観測した外部変更を cache にだけ反映する (エディタは触らない)。 */
	applyCacheReload: (path: string, loaded: string) => void;
	/** 外部変更を active タブのエディタへ反映する。自分の write なら何もしない。 */
	applyActiveReload: (path: string, loaded: string) => void;
	/** コンフリクトダイアログの「再読み込み」。cache を全置換して dirty を落とす。 */
	applyConflictReload: (path: string, loaded: string) => void;
	/** cache からタブの内容を捨てる (タブ自体の close は呼び出し側の責務)。 */
	dropTab: (path: string) => void;
	/** cache 上でそのタブに未保存の編集が無いか。cache 自体が無ければ false。 */
	isCachedTabClean: (path: string) => boolean;
}

/**
 * タブごとの本文キャッシュと、その保存・切替・close/rename/delete を一手に引き受ける。
 *
 * 外部からの書き換え (file watcher / コンフリクト解決) は cache と savedContent の内部表現に
 * 触れる必要があるが、それらを ref のまま外へ配ると内部表現がそのまま契約になってしまう。
 * そのため applyCacheReload / applyActiveReload / applyConflictReload / dropTab という
 * 命令的 API だけを公開し、useExternalFileConflict はそれを呼ぶ。
 */
export function useTabContentManager({
	editorViewRef,
	onTabSwitch,
	onGoToLine,
}: UseTabContentManagerOptions): TabContentManager {
	const {
		activeTabPath,
		workspacePath,
		closeTab,
		closeTabById,
		setTabDirty,
		renameTab,
		closeTabsByPrefix,
		renameTabsByPrefix,
		bumpContentVersion,
	} = useWorkspaceStore(
		useShallow((s) => ({
			activeTabPath: s.activeTabPath,
			workspacePath: s.workspacePath,
			closeTab: s.closeTab,
			closeTabById: s.closeTabById,
			setTabDirty: s.setTabDirty,
			renameTab: s.renameTab,
			closeTabsByPrefix: s.closeTabsByPrefix,
			renameTabsByPrefix: s.renameTabsByPrefix,
			bumpContentVersion: s.bumpContentVersion,
		})),
	);

	// 呼び出し側の callback は identity が変わっても effect の dep 配列を動かしたくないので
	// ref 経由で最新を参照する (repo 内の他 hook と同じ idiom)。
	const onTabSwitchRef = useRef(onTabSwitch);
	onTabSwitchRef.current = onTabSwitch;
	const onGoToLineRef = useRef(onGoToLine);
	onGoToLineRef.current = onGoToLine;

	const [editorError, setEditorError] = useState<string | null>(null);

	// 本文を React state から外し、controlled CodeMirror の per-keystroke 全文再レンダーを
	// 避ける (#302)。loadedDoc はロード/タブ切替/外部リロード時のみ変わり、CodeMirror の
	// `value` にはこれを渡す。keystroke 毎の最新本文は editorViewRef 経由で直接読む。
	const [loadedDoc, setLoadedDoc] = useState("");
	const loadedDocRef = useRef(loadedDoc);
	loadedDocRef.current = loadedDoc;
	const getContent = useCallback(
		() => editorViewRef.current?.state.doc.toString() ?? loadedDocRef.current,
		[editorViewRef],
	);
	const [editorKey, setEditorKey] = useState(0);
	const [editorViewEpoch, setEditorViewEpoch] = useState(0);
	const isNewTab = activeTabPath ? isNewTabPath(activeTabPath) : false;
	const isEditorComposing = useCallback(
		() => editorViewRef.current?.composing ?? false,
		[editorViewRef],
	);
	const tabCacheRef = useRef(new Map<string, TabCache>());
	// MarkdownEditor の snapshot handle (captureSnapshot / restoreSnapshot) への参照 (#220)。
	const markdownEditorHandleRef = useRef<MarkdownEditorHandle | null>(null);
	const pendingGoToLineRef = useRef<GoToLineRequest | null>(null);

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
	const getLastSavedContentRef = useRef(getLastSavedContent);
	getLastSavedContentRef.current = getLastSavedContent;
	const prevTabPathRef = useRef<string | null>(null);
	const contentLoadedForPathRef = useRef<string | null>(null);
	const savedContentRef = useRef("");
	const saveNowRef = useRef(saveNow);
	saveNowRef.current = saveNow;
	const prevWorkspacePathRef = useRef(workspacePath);
	const justSwitchedRef = useRef(false);

	// Cache previous tab's content and restore new tab's content on switch
	useEffect(() => {
		// Clear cursor info and error when switching tabs
		onTabSwitchRef.current();
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
				onGoToLineRef.current(pendingGoToLineRef.current);
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
					onGoToLineRef.current(pendingGoToLineRef.current);
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

	// unmount 後に window close の保存処理を続行しないためのフラグ。
	// 旧実装で onWindowCloseRequested effect が持っていた `cancelled` に対応する。
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const saveAllTabs = useCallback(async (): Promise<SaveAllTabsResult> => {
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
			if (!mountedRef.current) return "cancelled";
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
		if (!mountedRef.current) return "cancelled";
		for (const { path, ok, content } of results) {
			if (ok) {
				const cached = tabCacheRef.current.get(path);
				if (cached) cached.savedContent = content;
				setTabDirty(path, false);
			} else {
				hasFailed = true;
			}
		}

		return hasFailed ? "failed" : "ok";
	}, [getContent, setTabDirty]);

	const getCachedContent = useCallback(
		(path: string): string | null => {
			if (path === useWorkspaceStore.getState().activeTabPath) {
				return getContent();
			}
			return tabCacheRef.current.get(path)?.content ?? null;
		},
		[getContent],
	);

	const queueGoToLine = useCallback((request: GoToLineRequest) => {
		pendingGoToLineRef.current = request;
	}, []);

	const applyActiveReload = useCallback(
		(path: string, loaded: string) => {
			// Only update editor state if this file is still the active tab
			if (useWorkspaceStore.getState().activeTabPath !== path) return;
			// Compare with last written content (processed) to detect our own saves
			if (loaded === getLastSavedContentRef.current()) return;
			savedContentRef.current = loaded;
			markSaved(loaded);
			setLoadedDoc(loaded);
			setEditorKey((k) => k + 1);
		},
		[markSaved],
	);

	const applyConflictReload = useCallback(
		(path: string, loaded: string) => {
			tabCacheRef.current.set(path, { content: loaded, savedContent: loaded });
			setTabDirty(path, false);
			// Only update editor state if this file is still the active tab
			if (useWorkspaceStore.getState().activeTabPath === path) {
				savedContentRef.current = loaded;
				markSaved(loaded);
				setLoadedDoc(loaded);
				setEditorKey((k) => k + 1);
			}
		},
		[markSaved, setTabDirty],
	);

	const dropTab = useCallback((path: string) => {
		tabCacheRef.current.delete(path);
	}, []);

	const isCachedTabClean = useCallback((path: string): boolean => {
		const cached = tabCacheRef.current.get(path);
		return cached ? cached.content === cached.savedContent : false;
	}, []);

	return {
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
		applyCacheReload: setCacheFromReload,
		applyActiveReload,
		applyConflictReload,
		dropTab,
		isCachedTabClean,
	};
}
