import { version as katexVersion } from "katex/package.json";
import type { PdfPageBreakCriterion } from "../types/pdf";
import { exportPdf, showSaveDialog, writeFile } from "./commands";
import { escapeHtml } from "./content";
import { markdownToHtml } from "./markdown-to-html";
import { type MermaidRenderOptions, renderMermaid } from "./mermaid";
import { basename } from "./path";
import { svgToPng } from "./svg-rasterize";

export type ExportTheme = "system" | "light" | "dark";
export type PageBreakLevel = "none" | "h1" | "h2" | "h3";
export type PageBreakCriterion = PdfPageBreakCriterion;

const LEVEL_NUM: Record<Exclude<PageBreakLevel, "none">, 1 | 2 | 3> = { h1: 1, h2: 2, h3: 3 };

/**
 * smart 抑制対象の見出しレベル直下のセクションを `<section class="pdf-section-keep">`
 * で wrap する (#93)。CSS Paged Media の `break-inside: avoid-page` を Chromium に
 * 任せれば、現ページ残量に section 全体が収まる時は同ページに保持し、収まらない時は
 * section の先頭で force-break される。
 *
 * セクションの終端は「次の同位以上の見出し」または body 末尾。HTML パースは
 * 重い依存を避けるため string-based（heading は markdown-to-html が出力する
 * `<h{n}>` 正規パターンに限定）。
 */
export function wrapSectionsInHtml(bodyHtml: string, smartLevel: 1 | 2 | 3): string {
	type Heading = { level: number; start: number };
	const headings: Heading[] = [];
	for (const m of bodyHtml.matchAll(/<h([1-6])\b[^>]*>/gi)) {
		headings.push({ level: Number.parseInt(m[1], 10), start: m.index ?? 0 });
	}
	if (headings.length === 0) return bodyHtml;

	type Section = { start: number; end: number };
	const sections: Section[] = [];
	for (let i = 0; i < headings.length; i++) {
		if (headings[i].level !== smartLevel) continue;
		let end = bodyHtml.length;
		for (let j = i + 1; j < headings.length; j++) {
			// 同位以上の見出しで section 終端
			if (headings[j].level <= smartLevel) {
				end = headings[j].start;
				break;
			}
		}
		sections.push({ start: headings[i].start, end });
	}
	if (sections.length === 0) return bodyHtml;

	// 末尾から wrap（offset 保持）
	let result = bodyHtml;
	for (let i = sections.length - 1; i >= 0; i--) {
		const s = sections[i];
		// trim 末尾の空白で `<section>...</section>` 後の余分な空行を避ける
		const inner = result.slice(s.start, s.end).replace(/\s+$/, "");
		result =
			result.slice(0, s.start) +
			`<section class="pdf-section-keep">${inner}</section>` +
			result.slice(s.end);
	}
	return result;
}

/**
 * `<!-- pagebreak -->` を `<hr class="pdf-pagebreak"/>` に変換する (#93)。
 * markdown を渡す段階で適用し、HTML / PDF どちらの経路でも著者マーカーを有効化する。
 * CSS で visibility:hidden + @media print の break-before:page を当てるため、画面上は
 * 不可視・印刷時にだけページ送りされる。
 */
export function preprocessPageBreakMarkers(markdown: string): string {
	return markdown.replace(/<!--\s*pagebreak\s*-->/gi, '\n\n<hr class="pdf-pagebreak"/>\n\n');
}

// CDN の katex バージョンを bundle 同梱版と同期 (#79)。
const KATEX_CSS_URL = `https://cdn.jsdelivr.net/npm/katex@${katexVersion}/dist/katex.min.css`;

/** ExportTheme を Mermaid 用の "light" | "dark" に解決する。system の場合は OS 設定を参照。 */
function resolveMermaidTheme(theme?: ExportTheme): "light" | "dark" {
	if (theme === "dark") return "dark";
	if (theme === "light") return "light";
	// system or undefined: OS のカラースキームを参照
	if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
		return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	}
	return "light";
}

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

interface MermaidMatch {
	index: number;
	length: number;
	source: string;
	indent: string;
}

/**
 * Mermaid fenced code blocks を検出する。
 * 3文字以上のバッククォートに対応し、開始と同じ長さ以上の閉じフェンスを要求する。
 * インデントされたフェンスにも対応。
 */
export function findMermaidCodeBlocks(markdown: string): MermaidMatch[] {
	const matches: MermaidMatch[] = [];
	// LF / CRLF どちらも行区切りとして扱う
	const lines = markdown.split(/\r\n|\n/);

	// 元文字列上の改行位置を検索して行頭オフセットを事前計算（CRLF 安全）
	const lineOffsets = new Array<number>(lines.length + 1);
	lineOffsets[0] = 0;
	let searchPos = 0;
	for (let k = 0; k < lines.length; k++) {
		if (k === lines.length - 1) {
			lineOffsets[k + 1] = markdown.length + 1;
		} else {
			const nlIndex = markdown.indexOf("\n", searchPos);
			lineOffsets[k + 1] = nlIndex === -1 ? markdown.length + 1 : nlIndex + 1;
			searchPos = nlIndex === -1 ? markdown.length : nlIndex + 1;
		}
	}

	let i = 0;
	while (i < lines.length) {
		const openMatch = lines[i].match(/^(\s*)(`{3,})\s*mermaid\s*$/);
		if (!openMatch) {
			i++;
			continue;
		}

		const fenceLen = openMatch[2].length;
		const closeRe = new RegExp(`^\\s*\`{${fenceLen},}\\s*$`);
		const startLineIdx = i;
		const contentLines: string[] = [];
		i++;

		while (i < lines.length && !closeRe.test(lines[i])) {
			contentLines.push(lines[i]);
			i++;
		}

		if (i < lines.length) {
			// 閉じフェンスが見つかった
			const source = contentLines.join("\n").trim();
			if (source) {
				const offset = lineOffsets[startLineIdx];
				// 閉じフェンス行のテキスト末尾まで（改行文字は含めない）
				const endOffset = lineOffsets[i] + lines[i].length;
				matches.push({
					index: offset,
					length: endOffset - offset,
					source,
					indent: openMatch[1],
				});
			}
			i++;
		}
	}

	return matches;
}

/**
 * SVG ルートの width / height 属性を `<img>` 用の属性文字列にする。
 * 2x PNG を 1x で表示する retina pattern 用（取れない場合は空文字）。
 */
export function extractSvgNaturalSizeAttrs(svg: string): string {
	const openMatch = svg.match(/<svg\b([^>]*)>/);
	if (!openMatch) return "";
	const attrs = openMatch[1];
	const wMatch = attrs.match(/\bwidth\s*=\s*"(\d+(?:\.\d+)?)"/);
	const hMatch = attrs.match(/\bheight\s*=\s*"(\d+(?:\.\d+)?)"/);
	if (!wMatch || !hMatch) return "";
	return ` width="${wMatch[1]}" height="${hMatch[1]}"`;
}

/**
 * Mermaid コードブロックを SVG に変換する。エラー時は元のコードブロックを残す。
 * `mermaidOptions`: 描画モード切替（PDF は `{htmlLabels:false, useMaxWidth:false}`、#106）。
 * `embedOptions.rasterize`: SVG → PNG 化して `<img>` 埋め込み（PDF 経路の SVG quirk
 * 完全 bypass、失敗時は inline SVG にフォールバック）。
 */
export async function preprocessMermaidBlocks(
	markdown: string,
	theme: "light" | "dark" = "light",
	mermaidOptions: MermaidRenderOptions = {},
	embedOptions: { rasterize?: boolean } = {},
): Promise<string> {
	const matches = findMermaidCodeBlocks(markdown);
	if (matches.length === 0) return markdown;

	let result = markdown;
	// Process in reverse order to preserve offsets
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		try {
			const svg = await renderMermaid(match.source, theme, mermaidOptions);
			let raw: string;
			if (embedOptions.rasterize) {
				try {
					// 2x PNG / 1x display の retina pattern (#106)
					const png = await svgToPng(svg, { scale: 2 });
					const sizeAttrs = extractSvgNaturalSizeAttrs(svg);
					raw = `<div class="mermaid-diagram"><img src="${png}"${sizeAttrs} alt="Mermaid diagram"/></div>`;
				} catch (err) {
					// fallback は inline SVG。失敗理由は DevTools へ必ず出す（silent 化禁止）
					console.error(
						"[scripta:#106] Mermaid PNG ラスタライズ失敗 → inline SVG フォールバック:",
						err,
					);
					raw = `<div class="mermaid-diagram">${svg}</div>`;
				}
			} else {
				raw = `<div class="mermaid-diagram">${svg}</div>`;
			}
			// 元のフェンスのインデントを保持する（リスト・引用内の構造維持）
			const replacement = match.indent
				? raw
						.split("\n")
						.map((line) => (line.length > 0 ? match.indent + line : line))
						.join("\n")
				: raw;
			result =
				result.slice(0, match.index) + replacement + result.slice(match.index + match.length);
		} catch {
			// Keep original code block on error
		}
	}

	return result;
}

/**
 * 強制改ページ対象の CSS セレクタを構築する (#93 CSS-only redesign)。
 *
 * - smart=true: smart 抑制対象（= level そのもの）より「上位」レベルのみ force-break。
 *   smart level 自体は break-after: avoid + (section criterion なら) section wrap で
 *   Chromium に判定を任せる。
 * - smart=false: level 自身と上位すべて force-break（旧 aggressive 動作）。
 */
function buildForceBreakSelectors(level: PageBreakLevel, smart: boolean): string {
	if (level === "none") return "";
	const num = LEVEL_NUM[level];
	// smart=true → force level = num - 1（h1 設定時は 0 で force-break なし）
	// smart=false → force level = num（level 自身を含めて全部 force-break）
	const maxForce = smart ? num - 1 : num;
	if (maxForce <= 0) return "";
	const sels: string[] = [];
	for (let i = 1; i <= maxForce; i++) sels.push(`h${i}`);
	return sels.join(", ");
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
	const forceSelectors = pageBreak
		? buildForceBreakSelectors(pageBreak.level, pageBreak.smart)
		: "";
	// modern + legacy `page-break-*` を両方出すのは古い Chromium / WebKit 互換のため
	// （pdf4.dev best practice ガイド準拠）。modern (`break-*`) は今後の標準、legacy は
	// 古いレンダラやライブラリへの保険。
	const forceBreakRule = forceSelectors
		? `${forceSelectors} { break-before: page; page-break-before: always; }`
		: "";

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${KATEX_CSS_URL}">
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
.mermaid-diagram { text-align: center; margin: 1em 0; }
.mermaid-diagram svg { max-width: 100%; height: auto; }
.mermaid-diagram img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid; margin: 1em 0; }
hr.pdf-pagebreak { border: 0; margin: 0; height: 0; visibility: hidden; }
ul, ol { padding-left: 1.5em; }
ul > li::marker { font-size: 0.75em; }
.task-list-item { list-style: none; }
input[type="checkbox"] { margin-right: 0.5em; }
${buildThemeCss(theme)}

@page {
  size: A4;
  margin: 20mm;
}
@media print {
  body { padding: 0; }
  pre { white-space: pre-wrap; word-wrap: break-word; }

  /* widow / orphan typographic guard (pdf4.dev: 3 is the recommended print value). */
  p, li, blockquote { widows: 3; orphans: 3; }

  /* 見出しは直後コンテンツと一緒に置く (heading widow 回避)。modern + legacy alias。 */
  h1, h2, h3, h4, h5, h6 {
    break-after: avoid;
    page-break-after: avoid;
  }

  /* 各ブロック単位は途中分割しない。 */
  p, li, pre, blockquote, table, img, .mermaid-diagram {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* 著者マーカー: \`<!-- pagebreak -->\` 由来。 */
  hr.pdf-pagebreak {
    break-before: page;
    page-break-before: always;
  }

  ${forceBreakRule}
}
</style>
</head>
<body>
${addTaskListClass(bodyHtml)}
</body>
</html>`;
}

/** Add .task-list-item class to <li> elements containing checkboxes.
 * Avoids relying on :has() CSS selector for older WebKit compatibility. */
function addTaskListClass(html: string): string {
	return html.replace(/<li><input /g, '<li class="task-list-item"><input ');
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

	const savePath = await showSaveDialog({
		defaultPath: defaultName,
		filters: [{ name: "HTML", extensions: ["html"] }],
	});

	if (!savePath) return false;

	const mermaidTheme = resolveMermaidTheme(options?.theme);
	const withMarkers = preprocessPageBreakMarkers(markdown);
	const preprocessed = await preprocessMermaidBlocks(withMarkers, mermaidTheme);
	const bodyHtml = markdownToHtml(preprocessed);
	// Mermaid SVG は固定テーマでレンダリングされるため、
	// system の場合も解決済みテーマで HTML 全体を統一する
	const htmlTheme = options?.theme === "system" || !options?.theme ? mermaidTheme : options.theme;
	const html = buildHtmlDocument(bodyHtml, title, htmlTheme);
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
	options?: {
		pageBreakLevel?: PageBreakLevel;
		smartPageBreak?: boolean;
		/**
		 * @deprecated #93 redesign 後、criterion は廃止。smart=true + level !== "none" なら
		 * 常に section wrap が走る。引数として渡されても無視される（後方互換のため保持）。
		 */
		pageBreakCriterion?: PageBreakCriterion;
		zoom?: number;
	},
): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}.pdf`;

	const savePath = await showSaveDialog({
		defaultPath: defaultName,
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	});

	if (!savePath) return false;

	const zoom = options?.zoom ?? 100;
	const scaleFactor = zoom / 100;
	const smart = options?.smartPageBreak ?? true;

	const pageBreak =
		options?.pageBreakLevel && options.pageBreakLevel !== "none"
			? { level: options.pageBreakLevel, smart }
			: undefined;

	// PDF 経路は SVG → PNG にラスタライズして印刷の SVG quirk を bypass (#106)。
	// 詳細は preprocessMermaidBlocks の JSDoc を参照。
	const withMarkers = preprocessPageBreakMarkers(markdown);
	const preprocessed = await preprocessMermaidBlocks(
		withMarkers,
		"light",
		{ htmlLabels: false, useMaxWidth: false },
		{ rasterize: true },
	);
	const bodyHtml = markdownToHtml(preprocessed, { breaks: true });

	// section の改ページ判定は main 側 (pdf.ts) で executeJavaScript により行う (#93 v5)。
	// renderer 側で wrap せず、main の script が heading 自身に inline break-before を
	// 注入することで wrapper ベースの quirk (overcaution) を完全に回避する。
	let html = buildHtmlDocument(bodyHtml, title, "light", pageBreak);

	if (scaleFactor !== 1) {
		// Compensate max-width so the content fills the same visual width
		// regardless of zoom (e.g. zoom 0.5 → max-width 1600px → visual 800px)
		const maxWidth = Math.round(800 / scaleFactor);
		const idx = html.indexOf("<body>");
		if (idx !== -1) {
			html = `${html.slice(0, idx)}<body style="zoom: ${scaleFactor}; max-width: ${maxWidth}px">${html.slice(idx + 6)}`;
		}
	}

	// 改ページ判定は CSS Paged Media（break-before/after/inside + widows/orphans + section
	// wrapper）に完全委譲する設計に移行 (#93)。動的 JS 測定は Chromium の実 layout との
	// 差分で中割れを引き起こすため廃止した。
	await exportPdf(html, savePath);
	return true;
}

export function buildFence(content: string): string {
	let max = 2;
	for (const m of content.matchAll(/`{3,}/g)) {
		if (m[0].length > max) max = m[0].length;
	}
	return "`".repeat(max + 1);
}

export function getDefaultPromptTemplate(): string {
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

{title}

## Markdownコンテンツ

{content}
`;
}

export function buildPromptFromTemplate(template: string, title: string, content: string): string {
	const fence = buildFence(content);
	const fencedContent = `${fence}markdown\n${content}\n${fence}`;
	return template.replace(/\{(title|content)\}/g, (_match, key: string) =>
		key === "title" ? title : fencedContent,
	);
}

function buildPrompt(title: string, content: string): string {
	return buildPromptFromTemplate(getDefaultPromptTemplate(), title, content);
}

/**
 * Markdown をプロンプト形式で .md ファイルにエクスポートする。
 * @returns save ダイアログでキャンセルされた場合は false
 */
export async function exportAsPrompt(
	markdown: string,
	filePath: string,
	customTemplate?: string | null,
): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}-prompt.md`;

	const savePath = await showSaveDialog({
		defaultPath: defaultName,
		filters: [{ name: "Markdown", extensions: ["md"] }],
	});

	if (!savePath) return false;

	const output =
		customTemplate != null
			? buildPromptFromTemplate(customTemplate, title, markdown)
			: buildPrompt(title, markdown);
	await writeFile(savePath, output);
	return true;
}
