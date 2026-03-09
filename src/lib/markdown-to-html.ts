import DOMPurify from "dompurify";
import katex from "katex";
import { Marked, type Token, type Tokens } from "marked";

function isEscaped(text: string, pos: number): boolean {
	let count = 0;
	let i = pos - 1;
	while (i >= 0 && text[i] === "\\") {
		count++;
		i--;
	}
	return count % 2 === 1;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

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

/** Check whether `pos` falls inside any of the sorted, merged ranges. */
function isInsideRanges(pos: number, ranges: Array<[number, number]>): boolean {
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

/** Collect ranges of fenced / indented code blocks and inline code spans in raw markdown. */
function collectRawCodeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	// Fenced code blocks (``` or ~~~), including those nested inside
	// blockquotes / lists via the container prefix pattern.
	const containerPrefix = /(?:[ \t]*(?:>|[-*+]|\d+\.)[ \t]*)*/;
	const fenceRe = new RegExp(
		`^${containerPrefix.source}[ \\t]{0,3}(\`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?\\n${containerPrefix.source}[ \\t]{0,3}\\1[ \\t]*$`,
		"gm",
	);
	for (const m of text.matchAll(fenceRe)) {
		ranges.push([m.index, m.index + m[0].length]);
	}

	// Indented code blocks: runs of lines indented by 4+ spaces or a tab.
	const indentedRe = /(?:^|\n)((?:(?:[ ]{4}|\t)[^\n]*(?:\n|$))+)/g;
	for (const m of text.matchAll(indentedRe)) {
		// m[1] is the indented block; offset is m.index + possible leading \n
		const start = m.index + m[0].indexOf(m[1]);
		ranges.push([start, start + m[1].length]);
	}

	// Merge fenced/indented ranges for binary search before scanning inline code.
	const blockRanges = mergeRanges(ranges);

	// Inline code spans: manually scan for backtick runs to avoid lookbehind
	// which is unsupported in older WebKit engines used by some Tauri WebViews.
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
 * Code spans and fenced code blocks are skipped — their content must
 * be preserved verbatim.
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

/**
 * Replace multi-line display math ($$...\n...\n$$) in raw markdown
 * before lexing. With `breaks: true`, newlines inside display math
 * would be converted to <br>, breaking KaTeX rendering.
 * Single-line $$...$$ is handled later by walkTokens.
 */
function preprocessDisplayMath(
	markdown: string,
	placeholders: MathPlaceholder[],
	nonce: string,
): string {
	const containerPrefix = /(?:[ \t]*(?:>|[-*+]|\d+\.)[ \t]*)*/;

	// Build ranges covered by fenced code blocks to skip them.
	// CommonMark allows 0-3 spaces indent and both ``` and ~~~ fences.
	// Also handles fences nested inside blockquotes / lists.
	const codeRanges: Array<[number, number]> = [];
	const fenceRe = new RegExp(
		`^${containerPrefix.source}[ \\t]{0,3}(\`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?\\n${containerPrefix.source}[ \\t]{0,3}\\1[ \\t]*$`,
		"gm",
	);
	for (const m of markdown.matchAll(fenceRe)) {
		codeRanges.push([m.index, m.index + m[0].length]);
	}

	// Match display math $$...$$ that spans at least one newline.
	// Handles both "$$ on its own line" and "$$content\nmore$$" patterns.
	// Uses (?:(?!\$\$)[\s\S]) to prevent matching across $$ boundaries.
	// Allows optional container prefixes for blockquote / list contexts.
	// Capture the prefix to preserve the container structure.
	return markdown.replace(
		new RegExp(
			`^(?=[ \\t]{0,3}\\S)(${containerPrefix.source})[ \\t]*\\$\\$((?:(?!\\$\\$)[\\s\\S])*?\\n(?:(?!\\$\\$)[\\s\\S])*?)\\$\\$[ \\t]*$`,
			"gm",
		),
		(match, prefix: string, rawTex: string, offset: number) => {
			if (codeRanges.some(([s, e]) => offset >= s && offset < e)) {
				return match;
			}
			// Determine the actual position of the opening $$ within the match
			const openingRelPos = match.indexOf("$$");
			if (openingRelPos === -1) return match;
			const openingPos = offset + openingRelPos;
			if (isEscaped(markdown, openingPos)) return match;
			// Determine the actual position of the closing $$
			const closingRelPos = match.trimEnd().lastIndexOf("$$");
			if (closingRelPos === -1 || closingRelPos === openingRelPos) return match;
			const closingPos = offset + closingRelPos;
			if (isEscaped(markdown, closingPos)) return match;

			// Strip only the container prefix captured on the opening $$ line.
			// Do NOT use the generic containerPrefix pattern here — it would
			// incorrectly strip leading -, +, * etc. from normal TeX content.
			const escapedPrefix = prefix ? prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
			const stripRe = escapedPrefix ? new RegExp(`^${escapedPrefix}`) : null;
			const dollarPh = `%%EDOLLAR_${nonce}%%`;
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
			// Preserve container prefix so blockquote/list structure remains intact
			return `${prefix}${placeholder}`;
		},
	);
}

function replaceMath(text: string, placeholders: MathPlaceholder[], nonce: string): string {
	let processed = text;
	const dollarPh = `%%EDOLLAR_${nonce}%%`;

	// Pass 1: Display math ($$...$$) — handles remaining $$...$$ after
	// preprocessDisplayMath has replaced multi-line instances.
	processed = processed.replace(
		/\$\$((?:(?!\$\$)[^\n])+)\$\$/g,
		(match, tex: string, offset: number) => {
			if (isEscaped(processed, offset)) return match;
			const closingDisplayPos = offset + match.length - 2;
			if (isEscaped(processed, closingDisplayPos)) return match;

			const texForKatex = tex.replaceAll(dollarPh, "\\$");
			const placeholder = `%%MATH_D_${nonce}_${placeholders.length}%%`;
			try {
				const html = katex.renderToString(texForKatex.trim(), {
					displayMode: true,
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
		},
	);

	// Pass 2: Inline math ($...$)
	processed = processed.replace(
		/\$((?:[^\n$\\]|\\.)+)\$/g,
		(match, tex: string, offset: number) => {
			if (isEscaped(processed, offset)) return match;
			const closingInlinePos = offset + match.length - 1;
			if (isEscaped(processed, closingInlinePos)) return match;

			const texForKatex = tex.replaceAll(dollarPh, "\\$");
			const placeholder = `%%MATH_I_${nonce}_${placeholders.length}%%`;
			try {
				const html = katex.renderToString(texForKatex.trim(), {
					displayMode: false,
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
		},
	);

	return processed;
}

function walkTokens(tokens: Token[], placeholders: MathPlaceholder[], nonce: string): void {
	for (const token of tokens) {
		// Only replace math in text tokens (not in code, link URLs, etc.)
		if (token.type === "text") {
			const t = token as Tokens.Text;
			t.text = replaceMath(t.text, placeholders, nonce);
			if (t.raw) t.raw = t.text;
		}

		// Paragraphs contain inline math in their raw text; re-lex after replacement
		if (token.type === "paragraph") {
			const p = token as Tokens.Paragraph;
			p.text = replaceMath(p.text, placeholders, nonce);
			// Paragraph raw also needs updating so Marked doesn't re-parse the original
			if (p.raw) p.raw = replaceMath(p.raw, placeholders, nonce);
		}

		// Recurse into child tokens
		if ("tokens" in token && Array.isArray(token.tokens)) {
			walkTokens(token.tokens, placeholders, nonce);
		}

		// List items have nested tokens
		if (token.type === "list") {
			const list = token as Tokens.List;
			for (const item of list.items) {
				if (Array.isArray(item.tokens)) {
					walkTokens(item.tokens, placeholders, nonce);
				}
			}
		}
	}
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
	const tokens = marked.lexer(preprocessed);

	// Walk token tree and replace math only in text nodes,
	// leaving link URLs, image paths, code spans etc. untouched.
	walkTokens(tokens, placeholders, nonce);

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
