import { save } from "@tauri-apps/plugin-dialog";
import { exportPdf, writeFile } from "./commands";
import { markdownToHtml } from "./markdown-to-html";
import { basename } from "./path";

export type ExportTheme = "system" | "light" | "dark";
export type PageBreakLevel = "none" | "h1" | "h2" | "h3";

const LIGHT_STYLES = `body { color: #333; background: #fff; }
code { background: #f8f8f8; }
pre { background: #f8f8f8; }
blockquote { border-left-color: #e8e8e8; color: #555; }
th, td { border-color: #e8e8e8; }
th { background: #f8f8f8; }
a { color: #2563eb; }
hr { border-top-color: #e8e8e8; }
li::marker { color: #999; }`;

const DARK_STYLES = `body { color: #d4d4d4; background: #1a1a1a; }
code { background: #222; }
pre { background: #222; }
blockquote { border-left-color: #333; color: #777; }
th, td { border-color: #333; }
th { background: #222; }
a { color: #60a5fa; }
hr { border-top-color: #333; }
li::marker { color: #777; }`;

function buildPageBreakCss(level: PageBreakLevel, smart: boolean): string {
	if (level === "none") return "";

	const selectors: string[] = ["h1"];
	if (level === "h2" || level === "h3") selectors.push("h2");
	if (level === "h3") selectors.push("h3");

	let css = `${selectors.join(", ")} { break-before: page; }`;

	if (smart) {
		css += "\n[data-no-break] { break-before: auto !important; }";
	}

	return css;
}

function applySmartPageBreaks(bodyHtml: string, level: PageBreakLevel): string {
	if (level === "none") return bodyHtml;
	const maxLevel = level === "h1" ? 1 : level === "h2" ? 2 : 3;

	const pattern = /<h([1-6])/g;
	const suppressSet = new Set<number>();
	let prevLevel = 0;
	let lastMatchEnd = 0;

	for (let m = pattern.exec(bodyHtml); m !== null; m = pattern.exec(bodyHtml)) {
		const current = Number.parseInt(m[1], 10);
		if (current > maxLevel) continue;

		const between = bodyHtml.slice(lastMatchEnd, m.index);
		const blockCount = (between.match(/<(?:p|ul|ol|pre|blockquote|table|hr|div)[\s>\/]/gi) || [])
			.length;

		if (prevLevel === 0 || (current > prevLevel && blockCount <= 1)) {
			suppressSet.add(m.index);
		}

		prevLevel = current;
		lastMatchEnd = m.index + m[0].length;
	}

	if (suppressSet.size === 0) return bodyHtml;

	return bodyHtml.replace(/<h([1-6])/g, (match, levelStr: string, offset: number) => {
		if (suppressSet.has(offset)) return `<h${levelStr} data-no-break`;
		return match;
	});
}

function buildThemeCss(theme: ExportTheme): string {
	if (theme === "light") {
		return LIGHT_STYLES;
	}
	if (theme === "dark") {
		return DARK_STYLES;
	}
	// system: use media query
	return `${LIGHT_STYLES}
@media (prefers-color-scheme: dark) {
  ${DARK_STYLES}
}`;
}

export function buildHtmlDocument(
	bodyHtml: string,
	title: string,
	theme: ExportTheme = "system",
	pageBreak?: { level: PageBreakLevel; smart: boolean },
): string {
	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.33/dist/katex.min.css">
<style>
:root {
  color-scheme: ${theme === "dark" ? "dark" : theme === "light" ? "light" : "light dark"};
}
body {
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.6;
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.3;
}
h1 { font-size: 1.8em; font-weight: 700; margin: 1.2em 0 0.3em; }
h2 { font-size: 1.5em; font-weight: 700; margin: 1em 0 0.25em; }
h3 { font-size: 1.25em; font-weight: 600; margin: 0.8em 0 0.2em; }
h4 { font-size: 1.1em; font-weight: 600; margin: 0.6em 0 0.15em; }
h5 { font-size: 1em; font-weight: 600; margin: 0.5em 0 0.1em; }
h6 { font-size: 0.9em; font-weight: 600; margin: 0.5em 0 0.1em; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.9em;
  padding: 0.2em 0.4em;
  border-radius: 3px;
}
pre {
  padding: 0.8em 1em;
  border-radius: 6px;
  overflow-x: auto;
}
pre code {
  background: none;
  padding: 0;
}
blockquote {
  border-left: 3px solid;
  margin: 0.5em 0;
  padding: 0 0 0 0.75em;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}
th, td {
  border: 1px solid;
  padding: 0.5em 0.75em;
  text-align: left;
}
th { font-weight: 600; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid; margin: 1em 0; }
ul, ol { padding-left: 1.5em; }
ul > li::marker { font-size: 0.75em; }
li:has(> input[type="checkbox"]) { list-style: none; }
input[type="checkbox"] { margin-right: 0.5em; }
${buildThemeCss(theme)}

@page {
  size: A4;
  margin: 20mm;
}
@media print {
  body { padding: 0; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  pre, blockquote, table, img { break-inside: avoid; }
${pageBreak ? `  ${buildPageBreakCss(pageBreak.level, pageBreak.smart).split("\n").join("\n  ")}` : ""}
}
</style>
</head>
<body>
${pageBreak?.smart ? applySmartPageBreaks(bodyHtml, pageBreak.level) : bodyHtml}
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function extractTitle(filePath: string): string {
	const name = basename(filePath);
	return name.replace(/\.md$/, "");
}

/**
 * Markdown を HTML ファイルとしてエクスポートする。
 * @returns save ダイアログでキャンセルされた場合は false
 */
export async function exportAsHtml(
	markdown: string,
	filePath: string,
	options?: { theme?: ExportTheme },
): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}.html`;

	const savePath = await save({
		defaultPath: defaultName,
		filters: [{ name: "HTML", extensions: ["html"] }],
	});

	if (!savePath) return false;

	const bodyHtml = markdownToHtml(markdown);
	const html = buildHtmlDocument(bodyHtml, title, options?.theme);
	await writeFile(savePath, html);
	return true;
}

/**
 * Markdown を PDF ファイルとしてエクスポートする。
 * @returns save ダイアログでキャンセルされた場合は false
 */
export async function exportAsPdf(
	markdown: string,
	filePath: string,
	options?: { pageBreakLevel?: PageBreakLevel; smartPageBreak?: boolean },
): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}.pdf`;

	const savePath = await save({
		defaultPath: defaultName,
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	});

	if (!savePath) return false;

	const pageBreak =
		options?.pageBreakLevel && options.pageBreakLevel !== "none"
			? { level: options.pageBreakLevel, smart: options.smartPageBreak ?? true }
			: undefined;

	const bodyHtml = markdownToHtml(markdown, { breaks: true });
	const html = buildHtmlDocument(bodyHtml, title, "light", pageBreak);
	await exportPdf(html, savePath);
	return true;
}

function buildFence(content: string): string {
	let max = 2;
	for (const m of content.matchAll(/`{3,}/g)) {
		if (m[0].length > max) max = m[0].length;
	}
	return "`".repeat(max + 1);
}

function buildPrompt(title: string, content: string): string {
	const fence = buildFence(content);
	return `# HTML変換プロンプト

以下のMarkdownコンテンツを、美しく整形されたHTMLファイルに変換してください。

## 要件

- 完全なHTMLドキュメント（DOCTYPE、head、body）
- スタイルは原則インラインCSSで記述（ただし数式用の KaTeX CSS/JS は CDN から読み込み可）
- レスポンシブデザイン対応
- @media (prefers-color-scheme: dark) によるダーク/ライト自動切替
- 数式は KaTeX を用い、CDN から必要な CSS/JS を読み込んでレンダリング
- コードブロックはモノスペースフォント + 背景色付き
- テーブルは罫線付き
- @media print ルールを含む

## ドキュメントタイトル

${title}

## Markdownコンテンツ

${fence}markdown
${content}
${fence}
`;
}

/**
 * Markdown をプロンプト形式で .md ファイルにエクスポートする。
 * @returns save ダイアログでキャンセルされた場合は false
 */
export async function exportAsPrompt(markdown: string, filePath: string): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}-prompt.md`;

	const savePath = await save({
		defaultPath: defaultName,
		filters: [{ name: "Markdown", extensions: ["md"] }],
	});

	if (!savePath) return false;

	const output = buildPrompt(title, markdown);
	await writeFile(savePath, output);
	return true;
}
