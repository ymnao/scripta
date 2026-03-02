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
	const codeRanges = collectCodeRanges(markdown);
	const placeholders: MathPlaceholder[] = [];

	let processed = markdown;

	// Pass 1: Display math ($$...$$)
	const displayRanges: CodeRange[] = [];
	processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;
		if (overlapsCode(offset, offset + match.length, codeRanges)) return match;

		displayRanges.push({ from: offset, to: offset + match.length });

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
	processed = processed.replace(/\$([^\n$]+)\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;
		if (overlapsCode(offset, offset + match.length, codeRanges)) return match;

		// Skip if overlapping with display math
		for (const dr of displayRanges) {
			if (offset < dr.to && offset + match.length > dr.from) return match;
		}

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

	// Restore math placeholders
	for (const { placeholder, html: mathHtml } of placeholders) {
		html = html.replace(placeholder, mathHtml);
	}

	return html;
}
