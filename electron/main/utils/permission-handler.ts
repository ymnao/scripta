import type { Session } from "electron";

// Electron Security Checklist Item #5: renderer から要求される permission を
// 明示的に全 deny する。scripta は notifications / media / geolocation /
// clipboard-read 等いずれの web permission も使わないため、handler 未登録時の
// デフォルト（多くは deny だが Electron 版アップで変わり得る）に暗黙依存せず、
// 「常に false を返す」契約をコードで自己ドキュメントする。
//
// - setPermissionRequestHandler: ユーザに尋ねる permission（通知 / 位置 / カメラ等）
// - setPermissionCheckHandler: sync 経路（HID / Serial 等の `navigator.*` query）
//
// 将来 dependency が permission を要求してきても本 handler が黙って deny する
// （結果として feature がオフのまま動く）。意図して permission を増やしたくなった
// ときは本ファイルを明示変更する設計。
export function installPermissionDenyHandlers(ses: Session): void {
	ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false);
	});
	ses.setPermissionCheckHandler(() => false);
}
