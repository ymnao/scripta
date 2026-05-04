import { ipcMain } from "electron";
import {
	canonicalize,
	clearWorkspaceRootsForWindow,
	registerWorkspaceRoot,
	unregisterWorkspaceRoot,
} from "../utils/path-guard";
import { persistWorkspacePath } from "./settings";

// renderer 経由で workspace:set を受け付ける際、main 側で「ユーザーが OS ネイティブ
// な操作（dialog.showOpenDialog や前回 settings 経由）で承認した path」だけを
// 許可するための approved 集合。
// これがないと、悪意ある/侵害された renderer が workspaceSet("/") のような任意 path
// で path-guard の allowedRoots を拡張し、ファイル I/O を全面解放できてしまう。
const approvedWorkspacePaths = new Set<string>();

export function approveWorkspacePath(rawPath: string): void {
	approvedWorkspacePaths.add(canonicalize(rawPath));
}

export function isWorkspacePathApproved(rawPath: string): boolean {
	try {
		return approvedWorkspacePaths.has(canonicalize(rawPath));
	} catch {
		// validatePath が throw する不正入力（相対パス・null byte 等）も拒否扱い
		return false;
	}
}

// 複数ウィンドウ対応のため、各 window (webContents.id 単位) が現在開いている
// workspace を保持する。path-guard 側の allowedRoots も window 単位の Set を
// 持つので、各 window は自分の root Set だけを介して fs IPC が通る。
// 旧設計にあった「全 window の union を ref-count で管理」は撤廃済み。
//
// 信頼境界の補足：approve リスト（approvedWorkspacePaths）はプロセス全体で
// 共有される。これは UX 上の選択（ユーザーが picker で承認した、または前回
// 起動時の saved workspacePath は別ウィンドウからも切り替えできる方が自然）。
// 厳密な「window A から B の workspace を絶対に覗かせない」を保証するには
// approve も window-scoped 化する設計変更が必要。詳しくは path-guard.ts を参照。
//
// Map に格納する値は canonicalize()（validatePath + realpath 正規化）後の文字列。
// raw 文字列のまま保持すると、symlink 経由・大小文字差・/var → /private/var
// などの表記揺れで「同じ実体なのに別物扱い」となる事故が起こる。
const windowWorkspaces = new Map<number, string>();

export function setActiveWorkspaceForWindow(webContentsId: number, path: string | null): void {
	const canonical = path === null ? null : canonicalize(path);
	const previous = windowWorkspaces.get(webContentsId);
	if (previous === canonical) return;

	if (previous !== undefined) {
		windowWorkspaces.delete(webContentsId);
		unregisterWorkspaceRoot(webContentsId, previous);
	}

	if (canonical !== null) {
		windowWorkspaces.set(webContentsId, canonical);
		registerWorkspaceRoot(webContentsId, canonical);
	}
}

// ウィンドウが close された時に呼ぶ。そのウィンドウの allowedRoots と
// transientWritePaths を path-guard 側でまとめて消し、ゾンビ window-id 経由で
// ガードが緩む事故を防ぐ。
export function unregisterWindow(webContentsId: number): void {
	windowWorkspaces.delete(webContentsId);
	clearWorkspaceRootsForWindow(webContentsId);
}

export function registerWorkspaceIpc(): void {
	ipcMain.handle("workspace:set", async (event, path: string | null) => {
		// renderer は任意 path を投げ得る。dialog 経由 / settings 経由で main が
		// 承認した path 集合に無い場合は拒否し、信頼境界を main 側に閉じ込める。
		// path === null（unregister）は常に許可。
		if (path !== null && !isWorkspacePathApproved(path)) {
			console.warn(`[workspace] rejected non-approved path: ${path}`);
			throw new Error("Permission denied: workspace not approved");
		}
		setActiveWorkspaceForWindow(event.sender.id, path);
		// 永続化は main 専用経路。renderer 側から settings:set("workspacePath", ...) で
		// 任意値を書き込めると、次回起動の bootstrap が「未承認 path を approve」する
		// 抜け穴になるため、approve 通過後に main がここから書き込む。
		await persistWorkspacePath(path);
	});
}

export const __testing = {
	setActiveWorkspaceForWindow,
	unregisterWindow,
	getWindowWorkspaces: (): Map<number, string> => new Map(windowWorkspaces),
	getApprovedWorkspacePaths: (): Set<string> => new Set(approvedWorkspacePaths),
	reset: (): void => {
		windowWorkspaces.clear();
		approvedWorkspacePaths.clear();
	},
};
