import { shell, type WebContents } from "electron";
import { isAllowedRendererUrl } from "./renderer-url";
import { isSafeExternalUrl } from "./url";

// renderer dir 外への遷移 / window open を遮断する navigation guard を web contents に
// 一括 install する。**main window と conflict window 両方で同じ guard を必ず設定する**:
//
// 1. setWindowOpenHandler: window.open / target=_blank / リンクからのウィンドウ生成を
//    全て deny。安全な外部 URL は OS のデフォルトブラウザに渡す
// 2. will-navigate: renderer dir 外の URL への遷移を preventDefault + 外部ブラウザへ
//    委譲（必要なら）。renderer dir 内の遷移（route 切替）は許可
//
// この guard を欠くと、renderer dir 外のローカル HTML が default session を共有し
// permission を引き継ぐ（実 PoC で conflict window 経由のリーク確認済み）。
export function attachNavigationGuards(webContents: WebContents): void {
	webContents.setWindowOpenHandler(({ url }) => {
		if (isSafeExternalUrl(url)) {
			void shell.openExternal(url).catch((error) => {
				console.error("Failed to open external URL:", url, error);
			});
		}
		return { action: "deny" };
	});
	webContents.on("will-navigate", (event, url) => {
		if (isAllowedRendererUrl(url)) return;
		event.preventDefault();
		if (isSafeExternalUrl(url)) {
			void shell.openExternal(url).catch((error) => {
				console.error("Failed to open external URL:", url, error);
			});
		}
	});
}
