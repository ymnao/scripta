import {
	BrowserWindow,
	dialog,
	type IpcMainInvokeEvent,
	type OpenDialogOptions,
	type OpenDialogReturnValue,
	type SaveDialogReturnValue,
} from "electron";
import type { SaveDialogOptions } from "../../preload/api";
import { handle } from "../utils/ipc-handle";
import { registerTransientWritePath } from "../utils/path-guard";
import { approveWorkspacePath } from "./workspace";

// ダイアログは「IPC を呼び出した window」の上に出すのが正解。focused/first で
// 代用すると、複数ウィンドウ時に sender と親ウィンドウがズレ、
// SaveDialog の transient capability 所有者と UI 上の親ウィンドウが食い違う。
function getOwnerWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
	return (
		BrowserWindow.fromWebContents(event.sender) ??
		BrowserWindow.getFocusedWindow() ??
		BrowserWindow.getAllWindows()[0] ??
		null
	);
}

function showOpenDialog(
	event: IpcMainInvokeEvent,
	opts: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
	const owner = getOwnerWindow(event);
	return owner ? dialog.showOpenDialog(owner, opts) : dialog.showOpenDialog(opts);
}

function showSaveDialog(
	event: IpcMainInvokeEvent,
	opts: SaveDialogOptions,
): Promise<SaveDialogReturnValue> {
	const owner = getOwnerWindow(event);
	return owner ? dialog.showSaveDialog(owner, opts) : dialog.showSaveDialog(opts);
}

export function registerDialogIpc(): void {
	handle("dialog:open-directory", async (event): Promise<string | null> => {
		const result = await showOpenDialog(event, { properties: ["openDirectory"] });
		if (result.canceled || result.filePaths.length === 0) return null;
		// OS ネイティブな folder picker を通過した path のみを「ユーザー承認済み」として
		// approve リストに入れる。window-scoped: この event の sender window にのみ有効。
		await approveWorkspacePath(event.sender.id, result.filePaths[0]);
		return result.filePaths[0];
	});

	handle("dialog:save", async (event, opts: SaveDialogOptions): Promise<string | null> => {
		const result = await showSaveDialog(event, opts);
		if (result.canceled || !result.filePath) return null;
		// ユーザーが明示的に選択した保存先は workspace 外でも書き込みを許可する。
		// transient 許可は (a) ダイアログを開いた window のスコープのみで有効、
		// (b) 書き込み成功後に consume、(c) window close で cleanup される短命 capability。
		await registerTransientWritePath(event.sender.id, result.filePath);
		return result.filePath;
	});
}
