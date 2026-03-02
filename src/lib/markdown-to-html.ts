import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";

const FENCED_CODE_RE = /^[ \t]*(`{3,}|~{3,})[\s\S]*?\n[ \t]*\1[ \t]*$/gm;
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

interface CodeRange {
	from: number;
	to: number;
}

function collectCodeRanges(markdown: string): CodeRange[] {
	const ranges: CodeRange[] = [];

	for (const match of markdown.matchAll(FENCED_CODE_RE)) {
		ranges.push({ from: match.index, to: match.index + match[0].length });
	}

	for (const match of markdown.matchAll(INLINE_CODE_RE)) {
		ranges.push({ from: match.index, to: match.index + match[0].length });
	}

	return ranges;
}

function overlapsCode(from: number, to: number, codeRanges: CodeRange[]): boolean {
	for (const range of codeRanges) {
		if (from < range.to && to > range.from) return true;
	}
	return false;
}

function isEscaped(text: string, pos: number): boolean {
	let count = 0;
	let i = pos - 1;
	while (i >= 0 && text[i] === "\\") {
		count++;
		i--;
	}
	return count % 2 === 1;
}

interface MathPlaceholder {
	placeholder: string;
	html: string;
}

/**
 * Markdown テキストを HTML 文字列に変換する。
 * GFM（テーブル・取り消し線・タスクリスト）と KaTeX 数式をサポート。
 */
export function markdownToHtml(markdown: string): string {
	const placeholders: MathPlaceholder[] = [];

	let processed = markdown;

	// Pass 1: Display math ($$...$$)
	// Collect code ranges from the current string before each pass so that
	// offsets in the replace callback match the actual string being searched.
	const codeRangesPass1 = collectCodeRanges(processed);
	processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;
		if (overlapsCode(offset, offset + match.length, codeRangesPass1)) return match;

		const placeholder = `%%MATH_DISPLAY_${placeholders.length}%%`;
		try {
			const html = katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
			placeholders.push({ placeholder, html });
		} catch {
			placeholders.push({ placeholder, html: `<span class="math-error">${tex}</span>` });
		}
		return placeholder;
	});

	// Pass 2: Inline math ($...$)
	// Re-collect code ranges from the modified string so offsets are correct.
	// Display math placeholders (%%MATH_DISPLAY_N%%) contain no '$', so the
	// inline regex cannot match within them — no explicit display-range check needed.
	const codeRangesPass2 = collectCodeRanges(processed);
	processed = processed.replace(/\$([^\n$]+)\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;
		if (overlapsCode(offset, offset + match.length, codeRangesPass2)) return match;

		const placeholder = `%%MATH_INLINE_${placeholders.length}%%`;
		try {
			const html = katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
			placeholders.push({ placeholder, html });
		} catch {
			placeholders.push({ placeholder, html: `<span class="math-error">${tex}</span>` });
		}
		return placeholder;
	});

	// Markdown → HTML
	const marked = new Marked({ gfm: true, breaks: false });
	let html = marked.parse(processed) as string;

	// Sanitize before restoring math placeholders so KaTeX output is not affected.
	html = DOMPurify.sanitize(html);

	// Restore math placeholders
	for (const { placeholder, html: mathHtml } of placeholders) {
		html = html.replace(placeholder, mathHtml);
	}

	return html;
}
