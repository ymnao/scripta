import { save } from "@tauri-apps/plugin-dialog";
import { exportPdf, writeFile } from "./commands";
import { markdownToHtml } from "./markdown-to-html";
import { renderMermaid } from "./mermaid";
import { basename } from "./path";

export type ExportTheme = "system" | "light" | "dark";
export type PageBreakLevel = "none" | "h1" | "h2" | "h3";

/** ExportTheme を Mermaid 用の "light" | "dark" に解決する。system の場合は OS 設定を参照。 */
function resolveMermaidTheme(theme?: ExportTheme): "light" | "dark" {
	if (theme === "dark") return "dark";
	if (theme === "light") return "light";
	// system or undefined: OS のカラースキームを参照
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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

const MERMAID_BLOCK_RE = /```mermaid\s*\n([\s\S]*?)```/g;

/**
 * Mermaid コードブロックを SVG に変換する。
 * エラー時は元のコードブロックをそのまま残す。
 */
export async function preprocessMermaidBlocks(
	markdown: string,
	theme: "light" | "dark" = "light",
): Promise<string> {
	const matches = [...markdown.matchAll(MERMAID_BLOCK_RE)];
	if (matches.length === 0) return markdown;

	let result = markdown;
	// Process in reverse order to preserve offsets
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const source = match[1].trim();
		if (!source) continue;
		try {
			const svg = await renderMermaid(source, theme);
			const replacement = `<div class="mermaid-diagram">${svg}</div>`;
			result =
				result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
		} catch {
			// Keep original code block on error
		}
	}

	return result;
}

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

	// Collect block element positions once to avoid O(n^2) substring scanning.
	const blockPattern = /<(?:p|ul|ol|pre|blockquote|table|hr|div)[\s>\/]/gi;
	const blockPositions: number[] = [];
	for (let bm = blockPattern.exec(bodyHtml); bm !== null; bm = blockPattern.exec(bodyHtml)) {
		blockPositions.push(bm.index);
	}

	const pattern = /<h([1-6])/g;
	const suppressSet = new Set<number>();
	let prevLevel = 0;
	let lastMatchEnd = 0;
	let blockIndex = 0;

	for (let m = pattern.exec(bodyHtml); m !== null; m = pattern.exec(bodyHtml)) {
		const current = Number.parseInt(m[1], 10);
		if (current > maxLevel) continue;

		// Advance blockIndex past elements before the previous heading
		while (blockIndex < blockPositions.length && blockPositions[blockIndex] < lastMatchEnd) {
			blockIndex++;
		}
		// Count block elements between previous heading and current one
		let blockCount = 0;
		let bi = blockIndex;
		while (bi < blockPositions.length && blockPositions[bi] < m.index) {
			blockCount++;
			bi++;
		}

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

/**
 * PDF用WebView内で実行される動的改ページ判定スクリプトを生成する。
 * 要素の実測高さに基づいてページ残量に収まるか判定し、
 * 収まる場合は data-no-break 属性を付与して改ページを抑制する。
 */
export function buildDynamicPageBreakScript(
	level: Exclude<PageBreakLevel, "none">,
	forceUpperBreak = false,
): string {
	const maxLevel = level === "h1" ? 1 : level === "h2" ? 2 : 3;
	// forceUpperBreak: maxLevel未満の見出し（例: h3設定ならh1,h2）は常に改ページ
	// h1設定時やオフ時は全レベルをsmart対象にする（forceLevel=0）
	const forceLevel = forceUpperBreak && maxLevel > 1 ? maxLevel - 1 : 0;
	return `(function() {
  var maxLevel = ${maxLevel};
  var forceLevel = ${forceLevel};
  var selectors = [];
  for (var i = 1; i <= maxLevel; i++) selectors.push('h' + i);
  var sel = selectors.join(',');

  // 1. A4印刷領域高さ(257mm = 297mm - 20mm*2)をルーラーdivで実測
  //    CSS zoom適用時、getBoundingClientRect() はzoom後の座標を返す。
  //    物理ページサイズは257mm固定なので、zoom分を補正して
  //    「1物理ページにzoomed座標で何px分収まるか」を求める。
  var zoom = parseFloat(document.body.style.zoom) || 1;
  var ruler = document.createElement('div');
  ruler.style.cssText = 'position:absolute;visibility:hidden;width:0;height:257mm;';
  document.body.appendChild(ruler);
  var pageHeight = ruler.getBoundingClientRect().height / zoom;
  document.body.removeChild(ruler);
  if (pageHeight <= 0) return;

  // 2. 静的 applySmartPageBreaks の結果を全クリア
  var allHeadings = document.querySelectorAll('[data-no-break]');
  for (var i = 0; i < allHeadings.length; i++) {
    allHeadings[i].removeAttribute('data-no-break');
  }

  // 3. 印刷レイアウトをシミュレーション
  //    スクリーン幅(800px)と印刷幅(170mm≈644px)の差でテキスト折り返しが変わり
  //    セクション高さが過小評価されるのを防ぐため、bodyを印刷幅に一時変更
  var origPadding = document.body.style.padding;
  var origWidth = document.body.style.width;
  var origMaxWidth = document.body.style.maxWidth;
  document.body.style.padding = '0';
  var pw = (170 / zoom) + 'mm';
  document.body.style.width = pw;
  document.body.style.maxWidth = pw;

  // 全対象見出しの break-before を一時無効化し自然レイアウトで高さ測定
  // pre も印刷時と同じ折り返しモードにする
  var style = document.createElement('style');
  style.textContent = sel + ' { break-before: auto !important; } pre { white-space: pre-wrap !important; word-wrap: break-word !important; }';
  document.head.appendChild(style);

  // レイアウト再計算を強制
  document.body.offsetHeight;

  // 安全マージン: 行高さを実測し、pageHeight から差し引く
  // スクリーンと印刷のレンダリング差（マージン折り畳み、リスト内のパディング、
  // break-inside:avoid による要素移動等）で累積的な測定誤差が発生するため、
  // 3行分の余裕を持たせて判定する
  var lineRuler = document.createElement('p');
  lineRuler.style.cssText = 'position:absolute;visibility:hidden;margin:0;padding:0;';
  lineRuler.textContent = 'x';
  document.body.appendChild(lineRuler);
  var safetyBuffer = lineRuler.getBoundingClientRect().height;
  document.body.removeChild(lineRuler);
  var safePageHeight = pageHeight - safetyBuffer * 3;

  // 4. body直下のブロック要素を列挙し、各要素の占有高さを測定
  //    セクション単位ではなくブロック要素単位で追跡することで、
  //    break-inside: avoid による段落移動を正確にシミュレーションする
  //    UL/OL は直接子の LI に展開する（LI は break-inside: avoid だが
  //    UL/OL 自体はリスト項目間で分割可能なため、LI 単位で追跡する必要がある）
  var blockTags = {H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,P:1,UL:1,OL:1,PRE:1,BLOCKQUOTE:1,TABLE:1,HR:1,IMG:1,DIV:1};
  var avoidBreakTags = {P:1,LI:1,PRE:1,BLOCKQUOTE:1,TABLE:1,IMG:1};
  var items = [];
  var ch = document.body.children;
  for (var i = 0; i < ch.length; i++) {
    var tag = ch[i].tagName;
    if (tag === 'UL' || tag === 'OL') {
      var lis = ch[i].children;
      for (var j = 0; j < lis.length; j++) {
        if (lis[j].tagName === 'LI') items.push(lis[j]);
      }
    } else if (tag in blockTags) {
      items.push(ch[i]);
    }
  }
  if (items.length === 0) {
    document.head.removeChild(style);
    document.body.style.padding = origPadding;
    document.body.style.width = origWidth;
    document.body.style.maxWidth = origMaxWidth;
    return;
  }

  // 各要素の占有高さ = 次要素のtopまでの距離（マージンを含む）
  var heights = [];
  for (var i = 0; i < items.length; i++) {
    var top = items[i].getBoundingClientRect().top;
    var nextTop = (i + 1 < items.length)
      ? items[i + 1].getBoundingClientRect().top
      : document.body.getBoundingClientRect().bottom;
    heights.push(Math.max(0, nextTop - top));
  }

  // 5. ページフローをシミュレーション
  //    見出し判定: 見出し + 直後コンテンツが現ページに収まるかチェック
  //    収まらない場合は改ページし見出しを次ページ頭へ移動
  //    （ページ頭の見出しなら段落が次ページへ溢れてOK）
  //    pageUsed追跡: break-inside: avoid の要素は分割されず次ページへ移動
  var pageUsed = 0;
  var firstTargetHeading = true;
  for (var i = 0; i < items.length; i++) {
    var el = items[i];
    var h = heights[i];
    var tag = el.tagName;
    var hMatch = tag.match(/^H([1-6])$/);
    var isTargetHeading = hMatch && parseInt(hMatch[1]) <= maxLevel;

    if (isTargetHeading) {
      var headingLevel = parseInt(hMatch[1]);
      if (firstTargetHeading) {
        // 最初の見出し: 常に data-no-break（白紙1ページ目を防ぐ）
        el.setAttribute('data-no-break', '');
        firstTargetHeading = false;
      } else if (forceLevel > 0 && headingLevel <= forceLevel) {
        // 上位見出し強制改ページ: smart抑制の対象外 → 常に改ページ
        pageUsed = 0;
      } else {
        // 見出し + 直後コンテンツ2ブロック分の最小必要高さを計算
        // 1ブロックだけだと導入文のみで判定してしまい、見出し+導入文だけが
        // ページ末尾に残って実際の内容が次ページに行く問題を防ぐ
        var minNeeded = h;
        var extra = 0;
        for (var k = i + 1; k < items.length && extra < 2; k++) {
          if (items[k].tagName.match(/^H[1-6]$/)) break;
          minNeeded += heights[k];
          extra++;
        }

        if (pageUsed + minNeeded <= safePageHeight) {
          // 見出し+直後コンテンツが現ページに収まる → 改ページ抑制
          el.setAttribute('data-no-break', '');
        } else {
          // 収まらない → 改ページ（見出しを次ページ頭へ）
          pageUsed = 0;
        }
      }
    }

    // pageUsedを更新（break-inside: avoid を考慮）
    var avoidBreak = (tag in avoidBreakTags);
    if (avoidBreak && pageUsed > 0 && pageUsed + h > pageHeight) {
      // break-inside: avoid の要素が現ページに収まらない → 次ページへ移動
      pageUsed = h;
    } else {
      pageUsed += h;
    }
    while (pageUsed >= pageHeight) {
      pageUsed -= pageHeight;
    }
  }

  // 6. 一時スタイル・レイアウトを復元
  document.head.removeChild(style);
  document.body.style.padding = origPadding;
  document.body.style.width = origWidth;
  document.body.style.maxWidth = origMaxWidth;
})();`;
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
.mermaid-diagram { text-align: center; margin: 1em 0; }
.mermaid-diagram svg { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid; margin: 1em 0; }
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
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  p, li, pre, blockquote, table, img { break-inside: avoid; }
${pageBreak ? `  ${buildPageBreakCss(pageBreak.level, pageBreak.smart).split("\n").join("\n  ")}` : ""}
}
</style>
</head>
<body>
${pageBreak?.smart ? applySmartPageBreaks(addTaskListClass(bodyHtml), pageBreak.level) : addTaskListClass(bodyHtml)}
</body>
</html>`;
}

/** Add .task-list-item class to <li> elements containing checkboxes.
 * Avoids relying on :has() CSS selector for older WebKit compatibility. */
function addTaskListClass(html: string): string {
	return html.replace(/<li><input /g, '<li class="task-list-item"><input ');
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

	const mermaidTheme = resolveMermaidTheme(options?.theme);
	const preprocessed = await preprocessMermaidBlocks(markdown, mermaidTheme);
	const bodyHtml = markdownToHtml(preprocessed);
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
	options?: {
		pageBreakLevel?: PageBreakLevel;
		smartPageBreak?: boolean;
		forceUpperBreak?: boolean;
		zoom?: number;
	},
): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}.pdf`;

	const savePath = await save({
		defaultPath: defaultName,
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	});

	if (!savePath) return false;

	const zoom = options?.zoom ?? 100;
	const scaleFactor = zoom / 100;

	const pageBreak =
		options?.pageBreakLevel && options.pageBreakLevel !== "none"
			? { level: options.pageBreakLevel, smart: options.smartPageBreak ?? true }
			: undefined;

	const preprocessed = await preprocessMermaidBlocks(markdown, "light");
	const bodyHtml = markdownToHtml(preprocessed, { breaks: true });
	let html = buildHtmlDocument(bodyHtml, title, "light", pageBreak);

	// PDF用: 静的判定を動的スクリプトで上書き
	// 本文中に生HTMLの </body> が含まれる可能性があるため、最後の出現を置換する
	if (pageBreak?.smart) {
		const script = buildDynamicPageBreakScript(pageBreak.level, options?.forceUpperBreak ?? false);
		const idx = html.lastIndexOf("</body>");
		if (idx !== -1) {
			html = `${html.slice(0, idx)}<script>${script}</script>\n</body>${html.slice(idx + 7)}`;
		}
	}

	if (scaleFactor !== 1) {
		// Compensate max-width so the content fills the same visual width
		// regardless of zoom (e.g. zoom 0.5 → max-width 1600px → visual 800px)
		const maxWidth = Math.round(800 / scaleFactor);
		const idx = html.indexOf("<body>");
		if (idx !== -1) {
			html = `${html.slice(0, idx)}<body style="zoom: ${scaleFactor}; max-width: ${maxWidth}px">${html.slice(idx + 6)}`;
		}
	}
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

	const savePath = await save({
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
