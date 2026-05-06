import type { OgpData } from "../../../src/types/ogp";

// 旧 Tauri 版 src-tauri/src/commands/ogp.rs の `parse_ogp` / `extract_og_meta` /
// `extract_title_tag` / `decode_html_entities` を 1:1 で TS に移植したパーサ。
// 正規表現ではなく `<` 区切り → `meta` 接頭辞 → 属性抽出 という線形 scan で
// HTML パースの fragility を回避する（全角 / 改行混入 / 属性順 不問）。
//
// なぜ正規表現／DOM パーサ（cheerio 等）を使わないか:
// - cheerio / parse5 等の DOM パーサは依存サイズが大きい
// - Stage 5 の OGP 抽出は title / description / image / site_name の 4 タグに限定で、
//   正規表現は属性順や改行で簡単に壊れる
// - 旧 Rust の線形 scan が本番運用で実績があり、port のリスクが最小
// - cheerio 等を導入する場合は `denyOnly` sandbox 制約でインストール時に
//   `.idea` / `.gitmodules` などのテストフィクスチャ作成が阻まれる問題もあった

export function decodeHtmlEntities(s: string): string {
	// `&amp;` を最後にデコードする。先にやると `&amp;lt;` → `&lt;` → `<` のように
	// 二重デコードが起こる。Rust 版と同じ順序。
	return s
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&#x27;", "'")
		.replaceAll("&#x2F;", "/")
		.replaceAll("&amp;", "&");
}

function extractAttribute(tag: string, attrName: string): string | null {
	const lower = tag.toLowerCase();
	// double quotes
	const dq = `${attrName}="`;
	let pos = lower.indexOf(dq);
	if (pos >= 0) {
		const start = pos + dq.length;
		const end = tag.indexOf('"', start);
		if (end >= 0) return tag.slice(start, end);
	}
	// single quotes
	const sq = `${attrName}='`;
	pos = lower.indexOf(sq);
	if (pos >= 0) {
		const start = pos + sq.length;
		const end = tag.indexOf("'", start);
		if (end >= 0) return tag.slice(start, end);
	}
	return null;
}

function extractOgMeta(html: string, property: string): string | null {
	const propPattern = `property="og:${property}"`;
	const propPatternSingle = `property='og:${property}'`;
	for (const segment of html.split("<")) {
		const lower = segment.toLowerCase();
		if (!lower.startsWith("meta")) continue;
		if (!lower.includes(propPattern) && !lower.includes(propPatternSingle)) continue;
		const content = extractAttribute(segment, "content");
		if (content !== null) {
			const decoded = decodeHtmlEntities(content);
			if (decoded.length > 0) return decoded;
		}
	}
	return null;
}

function extractTitleTag(html: string): string | null {
	const lower = html.toLowerCase();
	const start = lower.indexOf("<title");
	if (start < 0) return null;
	// "<title" の直後に空白 / 属性 / `>` のいずれかが来る。`>` を探して開始タグの
	// 終端を確定する（旧 Rust と同じ手順）。
	const afterTagOpen = start + 6;
	const closingBracket = html.indexOf(">", afterTagOpen);
	if (closingBracket < 0) return null;
	const contentStart = closingBracket + 1;
	const closingTag = lower.indexOf("</title>", contentStart);
	if (closingTag < 0) return null;
	const title = html.slice(contentStart, closingTag).trim();
	const decoded = decodeHtmlEntities(title);
	return decoded.length > 0 ? decoded : null;
}

export function parseOgp(html: string, url: string): OgpData {
	const title = extractOgMeta(html, "title") ?? extractTitleTag(html);
	const description = extractOgMeta(html, "description");
	const image = extractOgMeta(html, "image");
	const siteName = extractOgMeta(html, "site_name");
	return { title, description, image, siteName, url };
}
