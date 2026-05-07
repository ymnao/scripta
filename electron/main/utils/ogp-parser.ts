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

function isNameChar(c: string): boolean {
	return (
		(c >= "a" && c <= "z") ||
		(c >= "A" && c <= "Z") ||
		(c >= "0" && c <= "9") ||
		c === "_" ||
		c === "-" ||
		c === ":" ||
		c === "."
	);
}

function isWs(c: string): boolean {
	return c === " " || c === "\t" || c === "\n" || c === "\r";
}

// 単純 substring 検索だと `data-content="..."` のような部分一致を `content="..."` と
// 取り違える。属性名の **直前** を「タグ名直後 / 空白 / `/`」のいずれかに限定して
// 境界を検査する小さな状態機械で、各属性の (name, value) を 1 度だけ走査する。
//
// 想定入力: `meta property="og:title" content="..."` のような meta 単一タグの中身
// （`html.split("<")` の各 segment）。先頭のタグ名（"meta"）はスキップしてから
// 属性走査に入る。タグ末尾は `>` で打ち切る。
function* iterateAttributes(tag: string): Iterable<{ name: string; value: string }> {
	let i = 0;
	// タグ名（meta / Meta / MeTa 等）を飛ばす。タグ名は name 文字の連続。
	while (i < tag.length && isNameChar(tag[i])) i++;
	while (i < tag.length) {
		// `>` でタグ終了
		if (tag[i] === ">") return;
		// 属性名の前は空白 / `/`。それ以外なら何かおかしい入力なので 1 文字飛ばし。
		if (!isWs(tag[i]) && tag[i] !== "/") {
			i++;
			continue;
		}
		i++; // skip the boundary char
		// 続く空白も飛ばす
		while (i < tag.length && isWs(tag[i])) i++;
		if (i >= tag.length || tag[i] === ">") return;
		// 属性名取得
		const nameStart = i;
		while (i < tag.length && isNameChar(tag[i])) i++;
		if (i === nameStart) {
			// 名前文字以外（`/`連続等）。1 文字読み飛ばす。
			i++;
			continue;
		}
		const name = tag.slice(nameStart, i).toLowerCase();
		// 等号前の空白
		while (i < tag.length && isWs(tag[i])) i++;
		if (tag[i] !== "=") {
			// boolean attribute（値なし）
			yield { name, value: "" };
			continue;
		}
		i++; // skip `=`
		while (i < tag.length && isWs(tag[i])) i++;
		const quote = tag[i];
		if (quote === '"' || quote === "'") {
			const valueStart = i + 1;
			const valueEnd = tag.indexOf(quote, valueStart);
			if (valueEnd < 0) return; // 不完全タグ → 走査打ち切り
			yield { name, value: tag.slice(valueStart, valueEnd) };
			i = valueEnd + 1;
		} else {
			// unquoted value
			const valueStart = i;
			while (i < tag.length && !isWs(tag[i]) && tag[i] !== ">") i++;
			yield { name, value: tag.slice(valueStart, i) };
		}
	}
}

function extractOgMeta(html: string, property: string): string | null {
	const expected = `og:${property}`.toLowerCase();
	for (const segment of html.split("<")) {
		const lower = segment.toLowerCase();
		if (!lower.startsWith("meta")) continue;
		// 厳密な属性走査で `property="og:..."` を確認する（`data-property="og:..."`
		// や `og-property="og:..."` のような **属性名の部分一致** で誤マッチしない）。
		let matched = false;
		let content: string | null = null;
		for (const attr of iterateAttributes(segment)) {
			if (attr.name === "property" && attr.value.toLowerCase() === expected) matched = true;
			else if (attr.name === "content") content = attr.value;
		}
		if (matched && content !== null) {
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
