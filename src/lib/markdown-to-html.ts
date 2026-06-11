import DOMPurify from "dompurify";
import katex from "katex";
import {
	Marked,
	type RendererExtensionFunction,
	type TokenizerAndRendererExtension,
	type Tokens,
} from "marked";
import { escapeHtml, isEscaped } from "./content";

interface MathPlaceholder {
	placeholder: string;
	html: string;
}

/** Merge and sort an array of [start, end) ranges. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	if (ranges.length === 0) return [];
	const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [sorted[0]];
	for (let i = 1; i < sorted.length; i++) {
		const last = merged[merged.length - 1];
		if (sorted[i][0] <= last[1]) {
			if (sorted[i][1] > last[1]) last[1] = sorted[i][1];
		} else {
			merged.push(sorted[i]);
		}
	}
	return merged;
}

/**
 * Check whether `pos` falls inside any of the sorted, merged ranges.
 * Exported alongside `collectRawCodeRanges` for shared use.
 */
export function isInsideRanges(pos: number, ranges: Array<[number, number]>): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (pos < ranges[mid][0]) {
			hi = mid - 1;
		} else if (pos >= ranges[mid][1]) {
			lo = mid + 1;
		} else {
			return true;
		}
	}
	return false;
}

/**
 * Collect ranges of fenced / indented code blocks and inline code spans in raw markdown.
 * Exported so PDF preprocessing (`preprocessPageBreakMarkers`) can skip code regions when
 * replacing `<!-- pagebreak -->` markers.
 */
export function collectRawCodeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	// Container prefix for fenced / indented inside blockquotes / lists.
	const containerPrefix = /(?:[ \t]*(?:>|[-*+]|\d+\.)[ \t]*)*/;

	// Fenced code blocks (``` or ~~~). CommonMark spec: closing fence must use the
	// **same character** and be **at least as long** as the opening fence. Regex can't
	// express "back-reference with length ≥ captured" so scan line-by-line.
	// `\r?` を行末で許容して CRLF 入力でも閉じフェンスを正しく検出 (split('\n') で
	// 各行末に \r が残るため、明示的に許容しないと CRLF の正当な fenced code が
	// 「未閉じ」と誤判定され doc 末尾まで code 扱いになる)。
	const lines = text.split("\n");
	const lineOffsets: number[] = [0];
	for (let li = 0; li < lines.length; li++) {
		lineOffsets.push(lineOffsets[li] + lines[li].length + 1);
	}
	const openRe = new RegExp(`^${containerPrefix.source}[ \\t]{0,3}(\`{3,}|~{3,})[^\\n]*$`);
	let li = 0;
	while (li < lines.length) {
		const open = lines[li].match(openRe);
		if (!open) {
			li++;
			continue;
		}
		const fenceChar = open[1][0]; // ` or ~
		const fenceLen = open[1].length;
		const start = lineOffsets[li];
		const closeRe = new RegExp(
			`^${containerPrefix.source}[ \\t]{0,3}\\${fenceChar}{${fenceLen},}[ \\t]*\\r?$`,
		);
		let closed = false;
		for (let lj = li + 1; lj < lines.length; lj++) {
			if (closeRe.test(lines[lj])) {
				const end = lineOffsets[lj] + lines[lj].length;
				ranges.push([start, end]);
				li = lj + 1;
				closed = true;
				break;
			}
		}
		if (!closed) {
			// Unclosed fence: treat the rest of the document as code (matches CommonMark
			// "to the end of the containing block / document" behaviour).
			ranges.push([start, text.length]);
			break;
		}
	}

	// Indented code blocks: runs of lines indented by 4+ spaces or a tab,
	// including those inside blockquotes / lists via the container prefix.
	const indentedRe = new RegExp(
		`(?:^|\\n)((?:${containerPrefix.source}(?:[ ]{4}|\\t)[^\\n]*(?:\\n|$))+)`,
		"g",
	);
	for (const m of text.matchAll(indentedRe)) {
		// m[1] is the indented block; offset is m.index + possible leading \n
		const start = m.index + m[0].indexOf(m[1]);
		ranges.push([start, start + m[1].length]);
	}

	// Raw HTML <code>...</code> and <pre>...</pre> blocks.
	const htmlCodeRe = /<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi;
	for (const m of text.matchAll(htmlCodeRe)) {
		ranges.push([m.index, m.index + m[0].length]);
	}

	// Merge fenced/indented/HTML ranges for binary search before scanning inline code.
	const blockRanges = mergeRanges(ranges);

	// Inline code spans: scan manually because a code span pairs an opening
	// backtick run with a closing run of the *same length* (CommonMark), while
	// skipping escaped backticks and runs inside the block ranges above. That
	// run-length pairing can't be expressed as a single regex.
	const textLen = text.length;
	let i = 0;
	while (i < textLen) {
		if (text[i] !== "`") {
			i++;
			continue;
		}
		// Ensure start of backtick run (not preceded by `)
		if (i > 0 && text[i - 1] === "`") {
			i++;
			continue;
		}
		// Skip escaped backticks (\`)
		if (isEscaped(text, i)) {
			i++;
			continue;
		}
		// Count opening backtick run
		let j = i;
		while (j < textLen && text[j] === "`") j++;
		const runLen = j - i;
		// Search for matching closing run
		let k = j;
		let found = false;
		while (k < textLen) {
			if (text[k] !== "`") {
				k++;
				continue;
			}
			if (k > 0 && text[k - 1] === "`") {
				k++;
				continue;
			}
			let m = k;
			while (m < textLen && text[m] === "`") m++;
			if (m - k === runLen && (m >= textLen || text[m] !== "`")) {
				// Skip if inside a fenced/indented block (binary search)
				if (!isInsideRanges(i, blockRanges)) {
					ranges.push([i, m]);
				}
				i = m;
				found = true;
				break;
			}
			k = m;
		}
		if (!found) i = j;
	}

	return mergeRanges(ranges);
}

/**
 * Replace escaped dollar signs (\$) with placeholders before markdown
 * processing. This prevents marked from stripping the backslash,
 * which would make escape detection impossible later.
 *
 * Code spans, fenced / indented code blocks, and raw HTML <code>/<pre>
 * blocks are skipped — their content must be preserved verbatim.
 */
function preprocessEscapedDollars(text: string, nonce: string): string {
	const placeholder = `%%EDOLLAR_${nonce}%%`;
	const codeRanges = collectRawCodeRanges(text);

	const positions: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "$" && isEscaped(text, i)) {
			// Skip if inside a code range (binary search on sorted/merged ranges)
			if (isInsideRanges(i, codeRanges)) continue;
			positions.push(i);
		}
	}
	if (positions.length === 0) return text;

	const segments: string[] = [];
	let lastIndex = 0;
	for (const pos of positions) {
		segments.push(text.slice(lastIndex, pos - 1));
		segments.push(placeholder);
		lastIndex = pos + 1;
	}
	segments.push(text.slice(lastIndex));
	return segments.join("");
}

// Container prefix that can legitimately precede an opening `$$` on its line:
// only blockquote (`>`) / list (`-`/`*`/`+`/`N.`) markers and surrounding
// whitespace. Matches the empty string too (top-level, no container). Used to
// decide whether the opening-line prefix is structural (strip it from each TeX
// line) or body text (an in-line `$$`, leave content untouched).
const OPENING_LINE_PREFIX_RE = /^(?:[ \t]*(?:>|[-*+]|\d+\.)[ \t]*)*$/;

/**
 * Replace multi-line display math ($$...\n...\n$$) in raw markdown
 * before lexing. With `breaks: true`, newlines inside display math
 * would be converted to <br>, breaking KaTeX rendering.
 * Single-line $$...$$ is handled later by the `mathDisplay` inline extension.
 *
 * Matching uses the same lenient `$$...$$` pattern as the editor
 * (`DISPLAY_MATH_RE` in live-preview/math.ts) so Live Preview and PDF stay in
 * parity (#169): display math that starts mid-line or whose closing `$$` is
 * followed by trailing text is now captured here too, instead of leaking out
 * as raw `$$` (and being mis-parsed into lists/paragraphs). The line/end
 * anchors were dropped; only multi-line matches are placeholdered (single-line
 * ones stay with the inline extension, which is why preprocess exists — to stop
 * `breaks: true` from inserting <br> inside a math block).
 */
function preprocessDisplayMath(
	markdown: string,
	placeholders: MathPlaceholder[],
	nonce: string,
): string {
	// Code 範囲を skip するため共通 helper を使う。`collectRawCodeRanges` は CommonMark
	// 準拠で fenced (閉じ長 >= 開き長)・indented・raw `<pre>`/`<code>`・inline すべてを
	// 扱う。以前は local の `\1` 正規表現で同長閉じのみ拾っており、`<pre>` や indented
	// code 内の display math まで KaTeX 化してしまう不整合があった。
	const codeRanges = collectRawCodeRanges(markdown);
	const dollarPh = `%%EDOLLAR_${nonce}%%`;

	// Lenient $$...$$ match (no line/end anchors), with a $$ boundary guard so a
	// match never spans across an intervening $$ pair. `String.replace` visits
	// every match.
	return markdown.replace(/\$\$((?:(?!\$\$)[\s\S])+?)\$\$/g, (match, rawTex: string, offset) => {
		// Single-line $$...$$ → leave for the `mathDisplay` inline extension.
		// preprocess only owns multi-line math (its sole job is preventing
		// `breaks: true` from turning the inner newlines into <br>).
		if (!rawTex.includes("\n")) return match;
		// Skip math inside code (fenced / indented / raw <pre>/<code> / inline).
		if (isInsideRanges(offset, codeRanges)) return match;
		// Escape guard on the opening and closing $$.
		if (isEscaped(markdown, offset)) return match;
		const closingPos = offset + match.length - 2;
		if (isEscaped(markdown, closingPos)) return match;

		// The opening line's leading text (line start → opening $$). If it is a
		// pure container prefix (blockquote/list markers, or empty), strip that
		// same prefix from every TeX line so the inner content is clean. If it is
		// body text (mid-line $$), leave the TeX as-is — there is no prefix to
		// strip.
		const lineStart = markdown.lastIndexOf("\n", offset - 1) + 1;
		const openingLinePrefix = markdown.slice(lineStart, offset);
		const stripRe =
			OPENING_LINE_PREFIX_RE.test(openingLinePrefix) && openingLinePrefix.length > 0
				? new RegExp(`^${openingLinePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
				: null;

		const tex = rawTex
			.split("\n")
			.map((line) => (stripRe ? line.replace(stripRe, "") : line))
			.join("\n")
			.replaceAll(dollarPh, "\\$");

		const placeholder = `%%MATH_D_${nonce}_${placeholders.length}%%`;
		try {
			const html = katex.renderToString(tex.trim(), {
				displayMode: true,
				throwOnError: false,
			});
			placeholders.push({ placeholder, html });
		} catch {
			placeholders.push({
				placeholder,
				html: `<span class="math-error">${escapeHtml(tex)}</span>`,
			});
		}
		// The opening-line prefix is now outside the match, so it stays in the
		// output naturally — return only the placeholder.
		return placeholder;
	});
}

// marked の inline tokenizer extension が生成する math トークン。
// Tokens.Generic を拡張し、tokenizer の戻り値と renderer 引数の絞り込みに使う。
interface MathToken extends Tokens.Generic {
	type: "mathDisplay" | "mathInline";
	tex: string;
}

// 単一行 display math: /^\$\$...\$\$/。インライン tokenizer なので preprocessDisplayMath
// が複数行 ($$\n...\n$$) を placeholder 化した後の単一行だけが残る。
const INLINE_DISPLAY_MATH_RE = /^\$\$((?:(?!\$\$)[^\n])+)\$\$/;
// インライン math: /^\$...\$/。エディタ live-preview/math.ts の INLINE_MATH_RE と同形。
const INLINE_MATH_RE = /^\$((?:[^\n$\\]|\\.)+)\$/;

/**
 * KaTeX で tex を描画し、placeholder を発行して返す共通処理。
 * tex 中の EDOLLAR placeholder（\$ のエスケープ退避）を `\$` に復元してから描画する。
 * katex throw 時は replaceMath 時代と同形の `<span class="math-error">` を発行する。
 */
function renderMathPlaceholder(
	tex: string,
	displayMode: boolean,
	placeholders: MathPlaceholder[],
	nonce: string,
): string {
	const dollarPh = `%%EDOLLAR_${nonce}%%`;
	const texForKatex = tex.replaceAll(dollarPh, "\\$");
	const kind = displayMode ? "D" : "I";
	const placeholder = `%%MATH_${kind}_${nonce}_${placeholders.length}%%`;
	try {
		const html = katex.renderToString(texForKatex.trim(), {
			displayMode,
			throwOnError: false,
		});
		placeholders.push({ placeholder, html });
	} catch {
		placeholders.push({
			placeholder,
			html: `<span class="math-error">${escapeHtml(texForKatex)}</span>`,
		});
	}
	return placeholder;
}

/**
 * marked の inline tokenizer extension を生成するファクトリ。
 * placeholders / nonce をクロージャに閉じ込めるため markdownToHtml 呼び出し毎に
 * `new Marked` + `use` する。
 *
 * walkTokens 方式（text/paragraph の text/raw だけ書き換えて子トークンは触らない）は
 * math 内の `\,`（escape）や `_`（emphasis）で text トークンが分断され、正規表現が
 * `$$...$$` 全体にマッチせず生 `$$` 出力・`<em>` 混入・inline `$` のペアずれを起こす。
 * inline tokenizer で `$`/`$$` を最優先に消費することで、emphasis/escape より先に
 * math 範囲が確定し、これらの分断を構造的に防ぐ。
 *
 * display / inline の優先関係: marked の `use()` は tokenizer を unshift で登録する
 * ため実際の試行順は配列と逆（inline → display）だが、INLINE_MATH_RE は中身 1 文字
 * 以上を要求し先頭が `$`（= `$$` の 2 文字目）だと必ず失敗するので、`$$...$$` は
 * 試行順に依らず display 側が拾う（エディタの Pass 1 → Pass 2 と同じ結果になる）。
 *
 * escape ガードについて: `\$` は preprocessEscapedDollars で EDOLLAR placeholder 化
 * 済みなので、tokenizer に到達する `$` は未エスケープのみ。よって isEscaped ガードは不要。
 */
function createMathExtensions(
	placeholders: MathPlaceholder[],
	nonce: string,
): TokenizerAndRendererExtension[] {
	// renderer は marked の RendererExtensionFunction 互換シグネチャ。引数は
	// この tokenizer が生成した token のみが渡るので MathToken への絞り込みは安全。
	const renderer: RendererExtensionFunction = (token) => {
		const t = token as MathToken;
		return renderMathPlaceholder(t.tex, t.type === "mathDisplay", placeholders, nonce);
	};

	const displayExtension: TokenizerAndRendererExtension = {
		name: "mathDisplay",
		level: "inline",
		start(src) {
			return src.indexOf("$$");
		},
		tokenizer(src) {
			const m = INLINE_DISPLAY_MATH_RE.exec(src);
			if (!m) return undefined;
			const token: MathToken = { type: "mathDisplay", raw: m[0], tex: m[1] };
			return token;
		},
		renderer,
	};

	const inlineExtension: TokenizerAndRendererExtension = {
		name: "mathInline",
		level: "inline",
		start(src) {
			return src.indexOf("$");
		},
		tokenizer(src) {
			const m = INLINE_MATH_RE.exec(src);
			if (!m) return undefined;
			const token: MathToken = { type: "mathInline", raw: m[0], tex: m[1] };
			return token;
		},
		renderer,
	};

	// 優先関係は順序非依存（JSDoc 参照）。可読性のため display を先に並べる。
	return [displayExtension, inlineExtension];
}

/**
 * Markdown テキストを HTML 文字列に変換する。
 * GFM（テーブル・取り消し線・タスクリスト）と KaTeX 数式をサポート。
 *
 * @param options.breaks - true にすると単一改行を `<br>` に変換する（PDF 用）。
 *                         デフォルトは false（標準 Markdown の挙動）。
 */
export function markdownToHtml(markdown: string, options?: { breaks?: boolean }): string {
	const placeholders: MathPlaceholder[] = [];
	// Per-call nonce to prevent placeholder collision with user content
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

	// Normalize CRLF / CR to LF so regex patterns using \n work on Windows input
	const normalized = markdown.replace(/\r\n?/g, "\n");

	// Ensure empty task list items (e.g. "- [ ]") are recognized by marked.
	// marked requires content after [ ]/[x] to detect task lists.
	const withTasks = normalized.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[[ xX]\])\s*$/gm, "$1 \u200B");

	// Replace escaped $ with placeholders before markdown processing.
	// marked strips backslashes from \$, making escape detection impossible later.
	const dollarPlaceholder = `%%EDOLLAR_${nonce}%%`;
	const withEscapedDollars = preprocessEscapedDollars(withTasks, nonce);

	// Replace multi-line display math before lexing to prevent
	// `breaks: true` (when enabled) from inserting <br> inside math blocks.
	const preprocessed = preprocessDisplayMath(withEscapedDollars, placeholders, nonce);

	const breaks = options?.breaks ?? false;
	const marked = new Marked({ gfm: true, breaks });
	// inline tokenizer extension で単一行 display ($$...$$) / inline ($...$) math を
	// 処理する。emphasis/escape より先に math 範囲を確定させるため、text/paragraph の
	// text を後段で書き換える walkTokens 方式から置き換えた（子トークン分断対策）。
	marked.use({ extensions: createMathExtensions(placeholders, nonce) });
	const tokens = marked.lexer(preprocessed);

	// Render tokens to HTML
	let html = marked.parser(tokens);

	// Sanitize before restoring math placeholders so KaTeX output is not affected.
	html = DOMPurify.sanitize(html);

	// Restore math placeholders
	for (const { placeholder, html: mathHtml } of placeholders) {
		html = html.replace(placeholder, mathHtml);
	}

	// Restore escaped dollar placeholders to literal $
	html = html.replaceAll(dollarPlaceholder, "$");

	return html;
}
