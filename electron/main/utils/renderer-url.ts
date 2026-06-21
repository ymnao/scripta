import { join } from "node:path";

// renderer の URL（pathname まで含む）が、scripta の renderer dir 配下かを判定する。
// will-navigate / window-open / permission の信頼判定で共通利用する。
//
// **pathname まで含めて厳密に判定する**のが本関数の本質的契約。origin だけだと
// 「file: スキームのローカル HTML 一般」「dev origin の任意 path」全部を trust に含めて
// しまい、子 window で renderer dir 外のローカル HTML に遷移されると clipboard 等の
// permission が漏れる（実 PoC で確認済み: conflict window から任意 local HTML へ遷移
// → navigator.clipboard.readText が成功）。
//
// dev: ELECTRON_RENDERER_URL の origin と一致 + pathname が allowed の prefix 配下
// prod: file: スキーム + pathname が RENDERER_FILE_DIR 配下
const RENDERER_FILE_DIR = join(__dirname, "../renderer");

export function isAllowedRendererUrl(url: string): boolean {
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl) {
		try {
			const parsed = new URL(url);
			const allowed = new URL(devUrl);
			if (parsed.origin !== allowed.origin) return false;
			const basePath = allowed.pathname.endsWith("/")
				? allowed.pathname.slice(0, -1)
				: allowed.pathname;
			return parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`);
		} catch {
			return false;
		}
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "file:") return false;
		const path = decodeURIComponent(parsed.pathname);
		return path === RENDERER_FILE_DIR || path.startsWith(`${RENDERER_FILE_DIR}/`);
	} catch {
		return false;
	}
}
