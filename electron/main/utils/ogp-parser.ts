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

// `<title` の直後が「タグ名終端文字（空白 / `/` / `>`）」である開始位置を探す。
// 単純な indexOf("<title") だと `<titlebar>` のような別タグを誤マッチしうる。
function findTitleTagOpen(lowerHtml: string): number {
	let from = 0;
	while (true) {
		const idx = lowerHtml.indexOf("<title", from);
		if (idx < 0) return -1;
		const next = lowerHtml[idx + 6];
		if (next === undefined) return -1;
		if (
			next === " " ||
			next === "\t" ||
			next === "\n" ||
			next === "\r" ||
			next === "/" ||
			next === ">"
		) {
			return idx;
		}
		from = idx + 1;
	}
}

function extractTitleTag(html: string): string | null {
	const lower = html.toLowerCase();
	const start = findTitleTagOpen(lower);
	if (start < 0) return null;
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

// og:* property 名と OgpData のキーの対応。new property を増やすときはここに 1 行
// 追加するだけ。重複 og:* タグが現れた場合は **最初の出現** を採用する（旧 Rust
// `extract_og_meta` と同じ semantics）。
const OG_PROPERTY_KEYS = {
	"og:title": "title",
	"og:description": "description",
	"og:image": "image",
	"og:site_name": "siteName",
} as const;

type OgPropertyKey = (typeof OG_PROPERTY_KEYS)[keyof typeof OG_PROPERTY_KEYS];

export function parseOgp(html: string, url: string): OgpData {
	// HTML を 1 度だけ split して全 4 プロパティを **同時に** 抽出する（従来は
	// extractOgMeta を 4 回呼んで 4 周 scan していた）。link card の hot path で
	// 効くマイクロ最適化。
	const found: Partial<Record<OgPropertyKey, string>> = {};
	for (const segment of html.split("<")) {
		const lower = segment.toLowerCase();
		if (!lower.startsWith("meta")) continue;
		// "meta" 直後がタグ名終端文字（空白 / `/` / `>`）でないと別タグ。
		// 例: `<metadata property="og:title" ...>` を SVG が含んでいた場合に
		// 誤って OGP として拾わない。segment は `<` で split 済みなので末尾は
		// 通常 `>`（最後の segment は `>` を含まない可能性があるが、その場合は
		// セグメント内に空白/タグ記号が無い → meta + 4 文字を超える可能性は薄い）。
		const after = lower[4];
		if (
			after !== undefined &&
			after !== " " &&
			after !== "\t" &&
			after !== "\n" &&
			after !== "\r" &&
			after !== "/" &&
			after !== ">"
		) {
			continue;
		}
		let propValue: string | null = null;
		let contentValue: string | null = null;
		for (const attr of iterateAttributes(segment)) {
			if (attr.name === "property") propValue = attr.value.toLowerCase();
			else if (attr.name === "content") contentValue = attr.value;
		}
		if (propValue === null || contentValue === null) continue;
		const targetKey = OG_PROPERTY_KEYS[propValue as keyof typeof OG_PROPERTY_KEYS];
		if (!targetKey || found[targetKey] !== undefined) continue;
		const decoded = decodeHtmlEntities(contentValue);
		if (decoded.length > 0) found[targetKey] = decoded;
	}

	const title = found.title ?? extractTitleTag(html);
	return {
		title,
		description: found.description ?? null,
		image: found.image ?? null,
		siteName: found.siteName ?? null,
		url,
	};
}
