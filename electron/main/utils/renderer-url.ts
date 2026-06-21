// permission handler が受け取る requestingOrigin / requestingUrl が「信頼できる
// renderer 由来」かを判定するための utility。
//
// `index.ts` の `isAllowedRendererUrl` と論理が似ているが、目的と精度が異なる:
// - `isAllowedRendererUrl`: will-navigate / windowOpen の遷移先 URL 全体（pathname 含む）
//   を限定する。renderer のページ範囲内かまで厳密に判定する。
// - `isTrustedRendererOrigin`: permission の requestingOrigin（origin だけ）/
//   requestingUrl（full URL）を受けて、その origin が信頼 renderer のものかを判定する。
//   pathname は判定対象外（permission の Origin は origin level）。
//
// 用途を分ける理由は、permission handler の `requestingOrigin` は origin 文字列のみで
// pathname を持たないため、pathname まで含む厳密チェックを共有しても無意味 + 偽陰性に
// なるから。Origin が信頼 renderer のものなら permission を許可してよい、という別の
// セキュリティ境界として実装する。

// dev: ELECTRON_RENDERER_URL の origin と一致するかを判定。
// prod: renderer は packaged file:// から load されるので `file:` プロトコルのみ許可。
//   ※ `file://` は origin 不在の特殊スキーマで Electron の `requestingOrigin` には
//     `file://` がそのまま現れる（host なし）。
export function isTrustedRendererOrigin(originOrUrl: string): boolean {
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl) {
		try {
			return new URL(originOrUrl).origin === new URL(devUrl).origin;
		} catch {
			return false;
		}
	}
	try {
		return new URL(originOrUrl).protocol === "file:";
	} catch {
		return false;
	}
}
