import type { Session } from "electron";
import { isAllowedRendererUrl } from "./renderer-url";

// Electron Security Checklist Item #5: renderer から要求される permission を
// 明示的に管理する。scripta は基本「全 deny」が方針で、clipboard 系のみ
// 信頼 renderer に限り許可する。handler 未登録のデフォルト挙動に依存せず
// 「常に false を返す（または allowlist 経由でのみ true）」契約をコードで
// 自己ドキュメントする。
//
// - setPermissionRequestHandler: ユーザに尋ねる permission（通知 / 位置 / カメラ等）
// - setPermissionCheckHandler: sync 経路（HID / Serial 等の `navigator.*` query）

// main session の renderer に対してだけ許可する permission の allowlist。
// - clipboard-read: コンテキストメニュー「貼り付け」（MarkdownEditor.tsx の
//   navigator.clipboard.readText() 経路）
// - clipboard-sanitized-write: 「コピー」「切り取り」（MarkdownEditor / StatusBar）
//   ※ Electron は writeText もユーザ活性化なしの呼び出しは permission gated 化する
//   可能性があるため、defense in depth で含める
const MAIN_RENDERER_ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
	"clipboard-read",
	"clipboard-sanitized-write",
]);

// 全 web permission を deny する handler を install する。
// PDF export 用の隔離 session など、renderer の clipboard 機能が不要な session 向け。
// 将来 dependency が permission を要求してきても本 handler が黙って deny する。
export function installPermissionDenyHandlers(ses: Session): void {
	ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false);
	});
	ses.setPermissionCheckHandler(() => false);
}

// main renderer 用の permission handler。clipboard 系を「renderer dir 配下の URL」に
// 限り許可し、それ以外は全 deny する。**判定は requestingOrigin（origin level）では
// なく requestingUrl（pathname 含む）を `isAllowedRendererUrl` で評価する**: origin だけ
// だと file: スキーム全体 / dev origin 全体に対する trust になり、子 window で renderer
// dir 外のローカル HTML に遷移された場合に permission がリークする。
export function installMainSessionPermissionHandlers(ses: Session): void {
	ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
		if (!MAIN_RENDERER_ALLOWED_PERMISSIONS.has(permission)) {
			callback(false);
			return;
		}
		callback(isAllowedRendererUrl(details?.requestingUrl ?? ""));
	});
	ses.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
		if (!MAIN_RENDERER_ALLOWED_PERMISSIONS.has(permission)) return false;
		// requestingOrigin は origin のみ（pathname を持たない）ため details.requestingUrl
		// を使う。details.requestingUrl は Electron が必ず埋める前提だが、防衛的に
		// 欠落時は deny へ倒す。
		return isAllowedRendererUrl(details?.requestingUrl ?? "");
	});
}
