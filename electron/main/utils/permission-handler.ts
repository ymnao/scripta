import type { Session } from "electron";
import { isTrustedRendererOrigin } from "./renderer-url";

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

// main renderer 用の permission handler。clipboard 系を「信頼 renderer origin」に
// 限り許可し、それ以外は全 deny する。requesting URL / Origin が dev URL の origin
// と一致しない / packaged 本番で file: スキームでない場合は許可しない
// （renderer-url.ts の isTrustedRendererOrigin 参照）。
export function installMainSessionPermissionHandlers(ses: Session): void {
	ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
		if (!MAIN_RENDERER_ALLOWED_PERMISSIONS.has(permission)) {
			callback(false);
			return;
		}
		const url = details?.requestingUrl ?? "";
		callback(isTrustedRendererOrigin(url));
	});
	ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
		if (!MAIN_RENDERER_ALLOWED_PERMISSIONS.has(permission)) return false;
		return isTrustedRendererOrigin(requestingOrigin);
	});
}
