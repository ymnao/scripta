// scripta-asset:// protocol handler の登録ロジック。
// index.ts は defaultSession で、pdf.ts は隔離 partition で、それぞれ本ヘルパーを呼ぶ。
// 各 handler は path-guard (workspace 内か) 経由でファイルを配信する。

import { pathToFileURL } from "node:url";
import { net, type Session, session } from "electron";
import { urlPathnameToFsPath } from "../../preload/scripta-asset-url";
import { isPathWithinAnyAllowedRoot } from "./path-guard";

export const SCRIPTA_ASSET_SCHEME = "scripta-asset";

// 失敗時は status のみ返し本文に path を含めない (拒否された path がレンダラ DevTools
// から見える形だと、ワークスペース外パスの存在情報が漏れるため)。hostname を `localhost`
// 固定にするのは、悪意あるレンダラが任意ホスト名で URL を組み立てた際の挙動を予測可能
// にする目的 (特権スキームでホスト名は意味を持たないが、表記の一貫性を強制する)。
//
// PDF export の隔離 partition (pdf.ts の PDF_PARTITION) など、defaultSession 以外で
// も scripta-asset を解決したいケースがあるため Session を引数で受け取る。
export function registerScriptaAssetProtocol(
	targetSession: Session = session.defaultSession,
): void {
	targetSession.protocol.handle(SCRIPTA_ASSET_SCHEME, async (request) => {
		try {
			const url = new URL(request.url);
			if (url.hostname !== "localhost") {
				return new Response(null, { status: 400 });
			}
			const path = urlPathnameToFsPath(url.pathname);
			if (!(await isPathWithinAnyAllowedRoot(path))) {
				console.warn(`[scripta-asset] denied outside workspace: ${path}`);
				return new Response(null, { status: 403 });
			}
			return await net.fetch(pathToFileURL(path).toString());
		} catch (error) {
			console.error("[scripta-asset] failed:", error);
			return new Response(null, { status: 500 });
		}
	});
}
