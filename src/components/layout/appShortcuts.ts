import type { EditorView } from "@codemirror/view";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Shortcut } from "../../hooks/useShortcuts";
import { closeWindow } from "../../lib/commands";
import { cmdOrCtrl } from "../../lib/keyboard";
import { isNewTabPath } from "../../lib/path";
import { useWorkspaceStore } from "../../stores/workspace";
import type { SearchBarHandle } from "../search/SearchBar";
import type { SidebarPanel } from "./Sidebar";

/** buildAppShortcuts が必要とする AppLayout 側の state / ref / ハンドラ。 */
export interface AppShortcutDeps {
	activatePrevTab: () => void;
	activateNextTab: () => void;
	handleGoBack: () => Promise<void>;
	handleGoForward: () => Promise<void>;
	activeTabId: number | null;
	handleCloseTab: (id: number) => Promise<void>;
	setSidebarVisible: Dispatch<SetStateAction<boolean>>;
	setSidebarPanel: Dispatch<SetStateAction<SidebarPanel>>;
	setSlideViewActive: Dispatch<SetStateAction<boolean>>;
	handleExport: (path: string) => void;
	searchInputRef: RefObject<HTMLInputElement | null>;
	editorViewRef: RefObject<EditorView | null>;
	searchBarOpenRef: RefObject<boolean>;
	searchBarHandleRef: RefObject<SearchBarHandle | null>;
	setSearchBarExpanded: Dispatch<SetStateAction<boolean>>;
	setSearchBarInitialText: Dispatch<SetStateAction<string>>;
	setSearchBarOpen: Dispatch<SetStateAction<boolean>>;
	workspacePath: string | null;
	openNewTab: () => void;
	toggleScratchpad: () => void;
	setGoToLineOpen: Dispatch<SetStateAction<boolean>>;
	setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
	setHelpOpen: Dispatch<SetStateAction<boolean>>;
	slideShowOpen: boolean;
	commandPaletteOpen: boolean;
	settingsOpen: boolean;
	helpOpen: boolean;
	exportOpen: boolean;
	startSlideShow: () => void;
}

/**
 * AppLayout のキーボードショートカット定義を組み立てる。
 *
 * 配列順に評価して最初にマッチしたエントリを実行する (useShortcuts が listener を一元管理)。
 * 修飾キー付きの類似ショートカット (例: Cmd+Shift+[ vs Cmd+[) は shift 有り側を先に置く。
 * preventDefault は match=true 時に useShortcuts が自動で呼ぶため、run 側では呼ばない。
 * preventDefault を条件付きで抑制したいエントリは、そのガードを match に含めれば match=false
 * 時に preventDefault が走らない (editor-search-bar / go-to-line が該当)。
 *
 * useShortcuts は shortcuts 配列が毎レンダー再生成されることを前提にした設計 (内部で ref 同期)
 * なので、呼び出し側で useMemo する必要はない。
 */
export function buildAppShortcuts(deps: AppShortcutDeps): Shortcut[] {
	return [
		{
			// Cmd+Shift+[ / Cmd+Shift+{ — 前のタブ
			id: "prev-tab",
			match: (e) => cmdOrCtrl(e) && e.shiftKey && (e.key === "{" || e.key === "["),
			run: () => deps.activatePrevTab(),
		},
		{
			// Cmd+Shift+] / Cmd+Shift+} — 次のタブ
			id: "next-tab",
			match: (e) => cmdOrCtrl(e) && e.shiftKey && (e.key === "}" || e.key === "]"),
			run: () => deps.activateNextTab(),
		},
		{
			// Cmd+[ — 履歴戻る
			id: "history-back-bracket",
			match: (e) => cmdOrCtrl(e) && !e.shiftKey && e.key === "[",
			run: () => void deps.handleGoBack(),
		},
		{
			// Cmd+] — 履歴進む
			id: "history-forward-bracket",
			match: (e) => cmdOrCtrl(e) && !e.shiftKey && e.key === "]",
			run: () => void deps.handleGoForward(),
		},
		{
			// Alt+Left — 履歴戻る
			id: "history-back-alt",
			match: (e) => e.altKey && e.key === "ArrowLeft",
			run: () => void deps.handleGoBack(),
		},
		{
			// Alt+Right — 履歴進む
			id: "history-forward-alt",
			match: (e) => e.altKey && e.key === "ArrowRight",
			run: () => void deps.handleGoForward(),
		},
		{
			// Cmd+W / Cmd+Shift+W — タブ/ウィンドウを閉じる
			id: "close-tab-or-window",
			match: (e) => cmdOrCtrl(e) && e.key.toLowerCase() === "w",
			run: (e) => {
				if (e.shiftKey) {
					// Cmd+Shift+W: タブの有無に関わらずウィンドウを閉じる（未保存の変更は保存される）
					void closeWindow();
					return;
				}
				if (deps.activeTabId != null) {
					void deps.handleCloseTab(deps.activeTabId);
				} else {
					// タブがない時はウィンドウを閉じる
					void closeWindow();
				}
			},
		},
		{
			// Cmd+/ — サイドバー表示切替
			id: "toggle-sidebar",
			match: (e) => cmdOrCtrl(e) && !e.shiftKey && e.key === "/",
			run: () => deps.setSidebarVisible((prev) => !prev),
		},
		{
			// Cmd+E — Files パネル
			id: "sidebar-files",
			match: (e) => cmdOrCtrl(e) && !e.shiftKey && e.key.toLowerCase() === "e",
			run: () => deps.setSidebarPanel("files"),
		},
		{
			// Cmd+Shift+S — スライドビュー切替 (active tab がファイルの時のみ)
			id: "toggle-slide-view",
			match: (e) => cmdOrCtrl(e) && e.shiftKey && e.key.toLowerCase() === "s",
			run: () => {
				const path = useWorkspaceStore.getState().activeTabPath;
				if (path && !isNewTabPath(path)) {
					deps.setSlideViewActive((prev) => !prev);
				}
			},
		},
		{
			// Cmd+Shift+E — Export
			id: "export",
			match: (e) => cmdOrCtrl(e) && e.shiftKey && e.key.toLowerCase() === "e",
			run: () => {
				const path = useWorkspaceStore.getState().activeTabPath;
				if (!path || isNewTabPath(path)) return;
				deps.handleExport(path);
			},
		},
		{
			// Cmd+Shift+F — 検索パネル
			id: "sidebar-search",
			match: (e) => cmdOrCtrl(e) && e.shiftKey && e.key.toLowerCase() === "f",
			run: () => {
				deps.setSidebarPanel("search");
				requestAnimationFrame(() => {
					deps.searchInputRef.current?.focus();
				});
			},
		},
		{
			// Cmd+Shift+U — Unresolved パネル切替
			id: "sidebar-unresolved",
			match: (e) => cmdOrCtrl(e) && e.shiftKey && e.key.toLowerCase() === "u",
			run: () => deps.setSidebarPanel((prev) => (prev === "unresolved" ? "files" : "unresolved")),
		},
		{
			// Cmd+Shift+B — Backlink パネル切替
			id: "sidebar-backlink",
			match: (e) => cmdOrCtrl(e) && e.shiftKey && e.key.toLowerCase() === "b",
			run: () => deps.setSidebarPanel((prev) => (prev === "backlink" ? "files" : "backlink")),
		},
		{
			// Cmd+F / Cmd+H — エディタ内検索/置換バー (エディタが存在する時のみ)
			id: "editor-search-bar",
			match: (e) =>
				cmdOrCtrl(e) &&
				!e.shiftKey &&
				(e.key === "f" || e.key === "h") &&
				deps.editorViewRef.current !== null,
			run: (e) => {
				const view = deps.editorViewRef.current;
				if (!view) return;
				const sel = view.state.selection.main;
				const selectedText =
					!sel.empty && sel.to - sel.from <= 200 ? view.state.sliceDoc(sel.from, sel.to) : "";
				if (deps.searchBarOpenRef.current) {
					// Already open: update text if there's a selection, then re-focus
					if (selectedText) {
						deps.searchBarHandleRef.current?.setSearch(selectedText);
					} else {
						deps.searchBarHandleRef.current?.focusInput();
					}
					if (e.key === "h") deps.setSearchBarExpanded(true);
				} else {
					deps.setSearchBarInitialText(selectedText);
					deps.setSearchBarExpanded(e.key === "h");
					deps.setSearchBarOpen(true);
				}
			},
		},
		{
			// Cmd+T — 新規タブ (workspace 無しでも preventDefault は行う: Electron/ブラウザ既定の新規タブ抑止)
			id: "new-tab",
			match: (e) => cmdOrCtrl(e) && !e.shiftKey && e.key.toLowerCase() === "t",
			run: () => {
				if (deps.workspacePath) deps.openNewTab();
			},
		},
		{
			// Cmd+J — スクラッチパッド切替 (workspace 無しでも preventDefault は行う: 既定挙動を抑止)
			id: "toggle-scratchpad",
			match: (e) => cmdOrCtrl(e) && !e.shiftKey && e.key.toLowerCase() === "j",
			run: () => {
				if (deps.workspacePath) deps.toggleScratchpad();
			},
		},
		{
			// Cmd+G — Go to line (エディタに focus がある時のみ)
			id: "go-to-line",
			match: (e) =>
				cmdOrCtrl(e) &&
				!e.shiftKey &&
				e.key.toLowerCase() === "g" &&
				!!deps.editorViewRef.current?.hasFocus,
			run: () => deps.setGoToLineOpen((prev) => !prev),
		},
		{
			// Cmd+P — コマンドパレット
			id: "command-palette",
			match: (e) => cmdOrCtrl(e) && e.key === "p",
			run: () => deps.setCommandPaletteOpen((prev) => !prev),
		},
		{
			// Cmd+, — 設定
			id: "settings",
			match: (e) => cmdOrCtrl(e) && e.key === ",",
			run: () => deps.setSettingsOpen((prev) => !prev),
		},
		{
			// F1 — ヘルプ
			id: "help",
			match: (e) => e.key === "F1",
			run: () => deps.setHelpOpen((prev) => !prev),
		},
		{
			// F5 素押し — 発表モード起動 (IME 合成中や他 modal open 中は横取りしない)。
			// Ctrl+F5 / Shift+F5 等はブラウザ/デバッガ側の慣例を尊重。
			id: "slide-show",
			match: (e) =>
				e.key === "F5" &&
				!cmdOrCtrl(e) &&
				!e.altKey &&
				!e.shiftKey &&
				!e.isComposing &&
				!deps.slideShowOpen &&
				!deps.commandPaletteOpen &&
				!deps.settingsOpen &&
				!deps.helpOpen &&
				!deps.exportOpen,
			run: () => deps.startSlideShow(),
		},
	];
}
