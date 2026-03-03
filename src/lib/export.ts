import { save } from "@tauri-apps/plugin-dialog";
import { exportPdf, writeFile } from "./commands";
import { markdownToHtml } from "./markdown-to-html";
import { basename } from "./path";

export type ExportTheme = "system" | "light" | "dark";

const LIGHT_STYLES = `body { color: #1a1a1a; background: #fff; }
h1, h2 { border-bottom-color: #e5e5e5; }
code { background: #f0f0f0; }
pre { background: #f6f6f6; }
blockquote { border-left-color: #ddd; color: #555; }
th, td { border-color: #ddd; }
th { background: #f6f6f6; }
a { color: #0366d6; }
hr { border-top-color: #e5e5e5; }`;

const DARK_STYLES = `body { color: #e0e0e0; background: #1a1a1a; }
h1, h2 { border-bottom-color: #333; }
code { background: #2d2d2d; }
pre { background: #252525; }
blockquote { border-left-color: #444; color: #aaa; }
th, td { border-color: #333; }
th { background: #252525; }
a { color: #58a6ff; }
hr { border-top-color: #333; }`;

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
  line-height: 1.8;
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
}
h1, h2, h3, h4, h5, h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  line-height: 1.3;
}
h1 { font-size: 2em; border-bottom: 1px solid; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.9em;
  padding: 0.15em 0.3em;
  border-radius: 3px;
}
pre {
  padding: 1em;
  border-radius: 6px;
  overflow-x: auto;
}
pre code {
  background: none;
  padding: 0;
}
blockquote {
  border-left: 4px solid;
  margin: 1em 0;
  padding: 0.5em 1em;
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
hr { border: none; border-top: 1px solid; margin: 2em 0; }
ul, ol { padding-left: 2em; }
input[type="checkbox"] { margin-right: 0.5em; }
${buildThemeCss(theme)}

@page {
  size: A4;
  margin: 20mm;
}
@media print {
  body { padding: 0; color: #000; background: #fff; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  a { color: #000; text-decoration: underline; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  pre, blockquote, table, img { break-inside: avoid; }
}
</style>
</head>
<body>
${bodyHtml}
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
	options?: { theme?: ExportTheme },
): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}.pdf`;

	const savePath = await save({
		defaultPath: defaultName,
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	});

	if (!savePath) return false;

	const bodyHtml = markdownToHtml(markdown);
	const html = buildHtmlDocument(bodyHtml, title, options?.theme ?? "light");
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
