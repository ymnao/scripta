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

function replaceMath(text: string, placeholders: MathPlaceholder[], nonce: string): string {
	let processed = text;

	// Pass 1: Display math ($$...$$)
	processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;

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
	processed = processed.replace(/\$([^\n$]+)\$/g, (match, tex: string, offset: number) => {
		if (isEscaped(processed, offset)) return match;

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
 */
export function markdownToHtml(markdown: string): string {
	const placeholders: MathPlaceholder[] = [];
	// Per-call nonce to prevent placeholder collision with user content
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

	const marked = new Marked({ gfm: true, breaks: false });
	const tokens = marked.lexer(markdown);

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

	return html;
}
