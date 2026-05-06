import type { BrowserWindow } from "electron";
import { clearSearchForWindow } from "../ipc/search";
import { stopWatcherForWindow } from "../ipc/watcher";
import { unregisterWindow } from "../ipc/workspace";

// 親 / 子 ウィンドウ共通の lifecycle 登録。close 時に IPC 上の per-window
// 状態をすべて掃除する。Stage 4 で conflict window が増えたため、main/index.ts
// の close handler を helper として切り出した。
//
// chokidar セッションを止めてからガード状態を解除する。順序を逆にすると、
// allowedRoots を消した直後に flush の webContents.send が走って `isDestroyed`
// チェックの前に起動した watcher が無関係なログを吐く可能性があるため。
//
// 副作用なしのモジュールにするため、window 集合の追跡（旧 main/index.ts の
// `openWindows`）は main/index.ts に残し、ここでは per-window IPC 状態の
// cleanup のみ責務とする。`onCleanup` は openWindows.delete などの追加処理を
// 注入できる hook（main/index.ts 専用 / テストでは省略可）。
export function attachWindowLifecycle(win: BrowserWindow, onCleanup?: () => void): void {
	const closingWindowId = win.webContents.id;
	win.on("closed", () => {
		onCleanup?.();
		stopWatcherForWindow(closingWindowId);
		clearSearchForWindow(closingWindowId);
		unregisterWindow(closingWindowId);
	});
}
