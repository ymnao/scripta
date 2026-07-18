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

/**
 * markdown img の src (相対 / 絶対 / http(s) / data / blob) を OS 絶対パスに解決する。
 * 解決できない (remote scheme / self-contained scheme / activeTabPath 不在で相対) 場合は
 * null。exportAsHtml の data URI 埋め込み経路 (#314) と `resolveImageSrc` の共通コア。
 */
export function resolveImageToOsPath(rawUrl: string, activeTabPath: string | null): string | null {
	if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return null;
	if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return null;
	if (rawUrl.startsWith("/") || rawUrl.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(rawUrl)) {
		return rawUrl;
	}
	if (!activeTabPath) return null;
	const dir = parentDir(activeTabPath);
	if (!dir) return null;
	let normalized = rawUrl;
	if (normalized.startsWith("./") || normalized.startsWith(".\\")) {
		normalized = normalized.slice(2);
	}
	const sep = detectSeparator(activeTabPath);
	const needsSep = !dir.endsWith("/") && !dir.endsWith("\\");
	return needsSep ? `${dir}${sep}${normalized}` : `${dir}${normalized}`;
}

export function resolveImageSrc(
	rawUrl: string,
	activeTabPath: string | null = useWorkspaceStore.getState().activeTabPath,
): string {
	const osPath = resolveImageToOsPath(rawUrl, activeTabPath);
	if (osPath === null) return rawUrl;
	return buildAssetUrl(osPath);
}
