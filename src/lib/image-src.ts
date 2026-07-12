// 相対 / 絶対 markdown 画像パスを asset protocol URL (scripta-asset://) に解決する。
// CodeMirror 依存を持たない純ユーティリティ (live-preview の image widget と
// SlidePreview / 将来の PDF export など複数箇所から利用するため lib 直下に配置)。

import { useWorkspaceStore } from "../stores/workspace";
import { buildAssetUrl } from "./commands";

/** dirname/getSep (path.ts) は最初のセパレータを基準にするが、
 *  mixed separator ("C:/Users\\docs\\note.md") では最後のセパレータを
 *  基準にする必要があるため、独自実装を維持する。 */
export function parentDir(filePath: string): string {
	const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (lastSep === -1) return "";
	if (lastSep === 0) return filePath[0];
	return filePath.substring(0, lastSep);
}

function detectSeparator(filePath: string): string {
	const lastSlash = filePath.lastIndexOf("/");
	const lastBackslash = filePath.lastIndexOf("\\");
	if (lastSlash === -1 && lastBackslash === -1) return "/";
	return lastBackslash > lastSlash ? "\\" : "/";
}

export function resolveImageSrc(
	rawUrl: string,
	activeTabPath: string | null = useWorkspaceStore.getState().activeTabPath,
): string {
	if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
		return rawUrl;
	}
	// data: / blob: は既に自己完結の URL なのでそのまま返す。
	// これらを相対パス分岐に落とすと activeTabPath 配下として scripta-asset URL に
	// 巻き取られ、画像が壊れる。
	if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) {
		return rawUrl;
	}
	if (rawUrl.startsWith("/") || rawUrl.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(rawUrl)) {
		return buildAssetUrl(rawUrl);
	}
	if (!activeTabPath) return rawUrl;
	const dir = parentDir(activeTabPath);
	if (!dir) return rawUrl;
	let normalized = rawUrl;
	if (normalized.startsWith("./") || normalized.startsWith(".\\")) {
		normalized = normalized.slice(2);
	}
	const sep = detectSeparator(activeTabPath);
	const needsSep = !dir.endsWith("/") && !dir.endsWith("\\");
	const resolved = needsSep ? `${dir}${sep}${normalized}` : `${dir}${normalized}`;
	return buildAssetUrl(resolved);
}
