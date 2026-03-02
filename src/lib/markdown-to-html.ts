import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";

const FENCED_CODE_RE = /^[ \t]*(`{3,}|~{3,})[\s\S]*?\n[ \t]*\1[ \t]*$/gm;

interface CodeRange {
	from: number;
	to: number;
}

function collectInlineCodeRanges(text: string): CodeRange[] {
	const ranges: CodeRange[] = [];
	let pos = 0;
	while (pos < text.length) {
		if (text[pos] !== "`") {
			pos++;
			continue;
		}
		const start = pos;
		while (pos < text.length && text[pos] === "`") pos++;
		const tickCount = pos - start;
		const closer = "`".repeat(tickCount);
		let searchFrom = pos;
		let found = false;
		while (searchFrom < text.length) {
			const idx = text.indexOf(closer, searchFrom);
			if (idx === -1) break;
			if (idx + tickCount < text.length && text[idx + tickCount] === "`") {
				searchFrom = idx + tickCount;
				while (searchFrom < text.length && text[searchFrom] === "`") searchFrom++;
				continue;
			}
			ranges.push({ from: start, to: idx + tickCount });
			pos = idx + tickCount;
			found = true;
			break;
		}
		if (!found) break;
	}
	return ranges;
}

function collectCodeRanges(markdown: string): CodeRange[] {
	const ranges: CodeRange[] = [];

	for (const match of markdown.matchAll(FENCED_CODE_RE)) {
		ranges.push({ from: match.index, to: match.index + match[0].length });
	}

	ranges.push(...collectInlineCodeRanges(markdown));

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

/**
 * Markdown テキストを HTML 文字列に変換する。
 * GFM（テーブル・取り消し線・タスクリスト）と KaTeX 数式をサポート。
 */
export function markdownToHtml(markdown: string): string {
	const placeholders: MathPlaceholder[] = [];
	// Per-call nonce to prevent placeholder collision with user content
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

	let processed = markdown;

	// Pass 1: Display math ($$...$$)
	// Collect code ranges from the current string before each pass so that
	// offsets in the replace callback match the actual string being searched.
	const codeRangesPass1 = collectCodeRanges(processed);
	processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;
		if (overlapsCode(offset, offset + match.length, codeRangesPass1)) return match;

		const placeholder = `%%MATH_D_${nonce}_${placeholders.length}%%`;
		try {
			const html = katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
			placeholders.push({ placeholder, html });
		} catch {
			placeholders.push({
				placeholder,
				html: `<span class="math-error">${escapeHtml(tex)}</span>`,
			});
		}
		return placeholder;
	});

	// Pass 2: Inline math ($...$)
	// Re-collect code ranges from the modified string so offsets are correct.
	// Display math placeholders contain no '$', so the inline regex cannot
	// match within them — no explicit display-range check needed.
	const codeRangesPass2 = collectCodeRanges(processed);
	processed = processed.replace(/\$([^\n$]+)\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;
		if (overlapsCode(offset, offset + match.length, codeRangesPass2)) return match;

		const placeholder = `%%MATH_I_${nonce}_${placeholders.length}%%`;
		try {
			const html = katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
			placeholders.push({ placeholder, html });
		} catch {
			placeholders.push({
				placeholder,
				html: `<span class="math-error">${escapeHtml(tex)}</span>`,
			});
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
