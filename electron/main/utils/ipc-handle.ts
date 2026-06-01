import { ipcMain } from "electron";
import { serializeIpcError } from "./structured-error";

// ipcMain.handle のラッパー。structured-error の純粋ロジック（分類 / serialize）から
// electron 依存を切り離すため、唯一 `ipcMain` を必要とする `handle()` のみを本モジュールへ
// 分離している。これにより structured-error.ts を import するテスト / preload 側は
// electron を引き込まずに済む。

// biome-ignore lint/suspicious/noExplicitAny: ipcMain.handle の listener シグネチャに合わせる
type IpcListener = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;

// listener が throw / reject した場合に serializeIpcError で構造化し、renderer へ kind
// 付きで伝える。成功時はそのまま値を返す（fast path にラップのオーバーヘッドのみ）。
export function handle(channel: string, listener: IpcListener): void {
	ipcMain.handle(channel, async (event, ...args) => {
		try {
			return await listener(event, ...args);
		} catch (err) {
			throw serializeIpcError(err);
		}
	});
}
