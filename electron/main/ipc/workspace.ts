import { handle } from "../utils/ipc-handle";
import {
	canonicalize,
	clearWorkspaceRootsForWindow,
	registerWorkspaceRoot,
	unregisterWorkspaceRoot,
} from "../utils/path-guard";
import { StructuredError } from "../utils/structured-error";
import { getWorkspacePathFromSettings, persistWorkspacePath } from "./settings";

// renderer 経由で workspace:set を受け付ける際、main 側で「ユーザーが OS ネイティブ
// な操作（dialog.showOpenDialog や前回 settings 経由）で承認した path」だけを
// 許可するための approved 集合。
// これがないと、悪意ある/侵害された renderer が workspaceSet("/") のような任意 path
// で path-guard の allowedRoots を拡張し、ファイル I/O を全面解放できてしまう。
//
// window-scoped 設計: approve リストは webContents.id 単位で管理する。
// window A で picker 承認した path は window B の workspace:set では受け付けない。
// これにより「侵害された renderer B が、正規 window A のユーザー操作で approve された
// path を利用して権限昇格する」攻撃経路を遮断する。
//
// 起動時の saved workspacePath は createWindow で当該 window に対して approve される。
// 補助ウィンドウ (New Window) は workspace 自動復元しないため approve 不要。
const approvedWorkspacePaths = new Map<number, Set<string>>();

export async function approveWorkspacePath(webContentsId: number, rawPath: string): Promise<void> {
	const canonical = await canonicalize(rawPath);
	const set = approvedWorkspacePaths.get(webContentsId) ?? new Set<string>();
	approvedWorkspacePaths.set(webContentsId, set);
	set.add(canonical);
}

export async function isWorkspacePathApproved(
	webContentsId: number,
	rawPath: string,
): Promise<boolean> {
	try {
		const canonical = await canonicalize(rawPath);
		const set = approvedWorkspacePaths.get(webContentsId);
		return set?.has(canonical) ?? false;
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
// 信頼境界: approve リスト（approvedWorkspacePaths）も window-scoped。
// window A で picker 承認した path は window B では使えない。起動時の saved
// workspace は createWindow で当該 window に対して approve される。
//
// Map に格納する値は canonicalize()（validatePath + realpath 正規化）後の文字列。
// raw 文字列のまま保持すると、symlink 経由・大小文字差・/var → /private/var
// などの表記揺れで「同じ実体なのに別物扱い」となる事故が起こる。
const windowWorkspaces = new Map<number, string>();

// New Window (Cmd+Shift+N) で開かれた補助ウィンドウは「workspace を永続化しない」
// 仕様（`AppLayout.tsx::isNewWindow` 参照）。renderer 側で startup の
// 復元を抑止するだけでは、補助ウィンドウから picker で別フォルダを開いた瞬間に
// `workspace:set` → `persistWorkspacePath` まで走り、メイン側 settings.json の
// 既定 workspace を上書きしてしまう。
//
// この set に入っている webContents.id からの `workspace:set` では永続化を行わず、
// in-memory の allowedRoots / windowWorkspaces 登録だけ行う。`unregisterWindow` で
// 削除されるため、ウィンドウ close 後に id が再利用されても残らない。
const volatileWorkspacePersistenceWindows = new Set<number>();

export function markWorkspacePersistenceVolatile(webContentsId: number): void {
	volatileWorkspacePersistenceWindows.add(webContentsId);
}

export async function setActiveWorkspaceForWindow(
	webContentsId: number,
	path: string | null,
): Promise<void> {
	const canonical = path === null ? null : await canonicalize(path);
	const previous = windowWorkspaces.get(webContentsId);
	if (previous === canonical) return;

	if (previous !== undefined) {
		windowWorkspaces.delete(webContentsId);
		await unregisterWorkspaceRoot(webContentsId, previous);
	}

	if (canonical !== null) {
		windowWorkspaces.set(webContentsId, canonical);
		await registerWorkspaceRoot(webContentsId, canonical);
	}
}

// ウィンドウが close された時に呼ぶ。そのウィンドウの allowedRoots と
// transientWritePaths と approvedWorkspacePaths を path-guard 側でまとめて消し、
// ゾンビ window-id 経由でガードが緩む事故を防ぐ。
export function unregisterWindow(webContentsId: number): void {
	windowWorkspaces.delete(webContentsId);
	approvedWorkspacePaths.delete(webContentsId);
	volatileWorkspacePersistenceWindows.delete(webContentsId);
	clearWorkspaceRootsForWindow(webContentsId);
}

export function registerWorkspaceIpc(): void {
	handle("workspace:set", async (event, path: string | null) => {
		// renderer は任意 path を投げ得る。dialog 経由 / settings 経由で main が
		// 承認した path 集合に無い場合は拒否し、信頼境界を main 側に閉じ込める。
		// path === null（unregister）は常に許可。
		if (path !== null && !(await isWorkspacePathApproved(event.sender.id, path))) {
			console.warn(`[workspace] rejected non-approved path: ${path}`);
			throw new StructuredError(
				"PATH_OUTSIDE_WORKSPACE",
				"Permission denied: workspace not approved",
			);
		}
		// 永続化を先に行うことで atomic 性を確保する。persistWorkspacePath が
		// throw した場合、allowedRoots は更新されないため「workspace は登録済みだが
		// settings は古い」という不整合が残らない。
		// renderer 側 settings:set("workspacePath", ...) で任意値を書き込めると、
		// 次回起動の bootstrap が「未承認 path を approve」する抜け穴になるため、
		// approve 通過後に main がここから書き込む。
		// 補助ウィンドウ（New Window）は意図的に永続化を行わない。renderer の
		// fetched workspace 値は不変で、in-memory の登録だけ更新する。
		if (!volatileWorkspacePersistenceWindows.has(event.sender.id)) {
			persistWorkspacePath(path);
		}
		await setActiveWorkspaceForWindow(event.sender.id, path);
	});
}

// 起動時に settings.json から読み込んだ workspacePath を、指定 window に対して
// approve する。createWindow で BrowserWindow を生成した直後に呼ぶ。
// renderer が workspace:set を打つ前に approve を完了させるため、renderer の
// loadFile/loadURL より前に await する。
export async function approveSavedWorkspaceForWindow(webContentsId: number): Promise<void> {
	const savedPath = getWorkspacePathFromSettings();
	if (savedPath === null) return;
	try {
		await approveWorkspacePath(webContentsId, savedPath);
	} catch (e) {
		console.warn("[bootstrap] failed to approve saved workspace path:", e);
	}
}

export const __testing = {
	setActiveWorkspaceForWindow,
	unregisterWindow,
	getWindowWorkspaces: (): Map<number, string> => new Map(windowWorkspaces),
	getApprovedWorkspacePaths: (): Map<number, Set<string>> =>
		structuredClone(approvedWorkspacePaths),
	getVolatileWorkspacePersistenceWindows: (): Set<number> =>
		new Set(volatileWorkspacePersistenceWindows),
	reset: (): void => {
		windowWorkspaces.clear();
		approvedWorkspacePaths.clear();
		volatileWorkspacePersistenceWindows.clear();
	},
};
