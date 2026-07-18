// 拡張子 (lower-case、先頭ドットなし) → MIME マッピング。
// exportAsHtml の data URI 埋め込み経路 (renderer 側 embedHtmlImagesAsDataUri) と、
// fs:read-base64 handler (main 側 ext 検証) の両方から参照する 1 SOT。
// 増やす時は「HTML img として意味を持つ画像形式」であることを確認する
// (mp4 等の video / audio / pdf は img で表示できないので追加しない)。
export const IMAGE_MIMES: Readonly<Record<string, string>> = Object.freeze({
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	avif: "image/avif",
});

/** 拡張子 (先頭ドット有無どちらでも可) から MIME を返す。未知拡張子は null。 */
export function mimeForImageExt(ext: string): string | null {
	const normalized = ext.startsWith(".") ? ext.slice(1) : ext;
	return IMAGE_MIMES[normalized.toLowerCase()] ?? null;
}
