import { katexInlineCss } from "../generated/katex-inline-css";
import {
	SLIDE_LOGICAL_HEIGHT,
	SLIDE_LOGICAL_PADDING_PX,
	SLIDE_LOGICAL_WIDTH,
	type SlideTheme,
} from "../types/slide";
import { buildFence } from "./code-fence";
import { exportPdf, showSaveDialog, writeFile } from "./commands";
import { escapeHtml } from "./content";
import { getDefaultPromptTemplate } from "./export-templates";
import { finalizeHtml } from "./finalize-html";
import { collectRawCodeRanges, isInsideRanges, markdownToHtmlRaw } from "./markdown-to-html";
// mermaid preprocess ヘルパーは循環参照回避のため独立モジュール化 (slide-render.ts が
// この経路を共有する)。既存 API 互換のため下記で re-export する。
import { preprocessMermaidBlocks } from "./mermaid-preprocess";
import { basename } from "./path";
import { embedHtmlImagesAsDataUri, resolveHtmlImageSrcs } from "./resolve-html-images";
import { extractSlideFrontmatterTheme, parseSlides } from "./slide-parser";
import { renderSlideHtmlWithMermaid } from "./slide-render";

export {
	extractSvgNaturalSizeAttrs,
	findMermaidCodeBlocks,
	preprocessMermaidBlocks,
} from "./mermaid-preprocess";

export type ExportTheme = "system" | "light" | "dark";
export type PageBreakLevel = "none" | "h1" | "h2" | "h3";
/** smart 改ページの keep 基準 (#93)。 */
export type PageBreakCriterion = "compact" | "section";

const LEVEL_NUM: Record<Exclude<PageBreakLevel, "none">, 1 | 2 | 3> = { h1: 1, h2: 2, h3: 3 };

/**
 * 改ページ判定の smart-level を解決する (#93)。
 *
 * ユーザ選択 `requested` を尊重するが、bodyHtml に該当 level の見出しが 2 件未満なら
 * 「複数回現れる最も浅いレベル (h2 > h3 > h1 > h4)」に自動補正する。これは
 * 「h1=タイトル 1 個 + h3=section 多数」のような典型 markdown 構造で「h2 まで」を
 * 選んでも適切に動作させるための妥協。
 *
 * 旧版は main 側 script の中 (executeJavaScript) で auto-detect していたが、policy を
 * renderer に集約することで (a) pure TS で unit test できる、(b) renderer が
 * `smart-level` と `force-level` を **一貫導出** できて clamp 不要、(c) script は
 * meta を読むだけで簡潔、というメリットを得る。
 *
 * 戻り値 `null` は「smart 改ページの対象見出しが見つからない」を意味し、script は
 * meta 不在 = no-op に degrade する。
 */
export function resolveSmartLevel(bodyHtml: string, requested: 1 | 2 | 3): 1 | 2 | 3 | 4 | null {
	const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
	for (const m of bodyHtml.matchAll(/<h([1-6])\b/g)) {
		counts[Number.parseInt(m[1], 10)]++;
	}
	if (counts[requested] >= 2) return requested;
	if (counts[2] >= 2) return 2;
	if (counts[3] >= 2) return 3;
	if (counts[1] >= 2) return 1;
	if (counts[4] >= 2) return 4;
	return null;
}

/**
 * `<!-- pagebreak -->` を `<hr class="pdf-pagebreak"/>` に変換する (#93)。
 * markdown を渡す段階で適用し、HTML / PDF どちらの経路でも著者マーカーを有効化する。
 * CSS で visibility:hidden + @media print の break-before:page を当てるため、画面上は
 * 不可視・印刷時にだけページ送りされる。
 *
 * fenced / indented / inline code / raw `<pre>` / `<code>` 内の文字列リテラルは
 * 置換しない (機能をドキュメントする目的の code sample 等を壊さないため)。
 * code 範囲検出は markdown-to-html.ts の `collectRawCodeRanges` を共有して、
 * KaTeX 等の他経路と完全一致させる。
 */
export function preprocessPageBreakMarkers(markdown: string): string {
	const codeRanges = collectRawCodeRanges(markdown);
	return markdown.replace(/<!--\s*pagebreak\s*-->/gi, (match, offset: number) =>
		isInsideRanges(offset, codeRanges) ? match : '\n\n<hr class="pdf-pagebreak"/>\n\n',
	);
}

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

/**
 * 強制改ページ対象の CSS セレクタを構築する (#93)。
 *
 * - smart=true: smart 抑制対象 (= level そのもの) より「上位」レベルのみ force-break。
 *   smart level 自体は break-after: avoid CSS + main 側 script の inline break-before
 *   注入で扱う。
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
	pageBreak?: { level: PageBreakLevel; smart: boolean; criterion?: PageBreakCriterion },
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

	// smart 改ページ設定を meta tag 経由で main 側 script に伝える (#93)。
	// - smart-level: bodyHtml の見出し分布も考慮した resolved レベル (1〜4)。script は
	//   これを smart-suppression 対象として break-before を inline 注入する。
	// - criterion: section (default, 全体 keep) / compact (heading + 直後ブロックのみ keep)。
	// **meta tag が無い場合は script は即 return** (smart=false / level=none / 文書に
	// 対象見出し不足 で確実に no-op)。
	// force-level は smart-level - 1 として script 側で導出するので transport 不要。
	let scriptMeta = "";
	if (pageBreak?.smart && pageBreak.level !== "none") {
		const smartLevel = resolveSmartLevel(bodyHtml, LEVEL_NUM[pageBreak.level]);
		if (smartLevel !== null) {
			scriptMeta =
				`<meta name="scripta-pdf-smart-level" content="${smartLevel}">\n` +
				`<meta name="scripta-pdf-criterion" content="${pageBreak.criterion ?? "section"}">\n`;
		}
	}

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${scriptMeta}<title>${escapeHtml(title)}</title>
<style>${katexInlineCss}</style>
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
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
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
	// 相対 / 絶対 workspace パスのローカル画像を data URI として埋め込む (#314)。
	// scripta-asset:// では外部ブラウザから解決不能なため、HTML 単体で self-contained
	// にするにはインライン化が必要。activeTabPath は書き出し元の md path で代用する。
	// HTML export は data:image/* を埋め込むが DOMPurify default の DATA_URI_TAGS が
	// `<img>` 等の data: を既に許可するため、finalizeHtml に追加オプションは要らない。
	const bodyHtml = finalizeHtml(
		await embedHtmlImagesAsDataUri(markdownToHtmlRaw(preprocessed), filePath),
	);
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
		 * #93 v5.4 で復活。`section` (default) はセクション全体を keep-together、
		 * `compact` は heading + 直後ブロックのみ keep-together で中割れ許容。
		 * smart=false の時は無視される。
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
	const criterion: PageBreakCriterion = options?.pageBreakCriterion ?? "section";

	const pageBreak =
		options?.pageBreakLevel && options.pageBreakLevel !== "none"
			? { level: options.pageBreakLevel, smart, criterion }
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
	// activeTabPath 基準で `![](./foo.png)` などを `scripta-asset://` に解決する
	// (相対のままだと main の隔離セッションが temp file 隣に画像が無いため 404 になる)。
	// PDF 経路の scripta-asset 解決は pdf.ts 側でも協力が必要 (protocol 登録 + webRequest
	// 白リスト)。HTML export は外部ブラウザで開かれる前提のため対象外 (data URI 埋め込みは
	// 別 PR)。
	const bodyHtml = finalizeHtml(
		resolveHtmlImageSrcs(markdownToHtmlRaw(preprocessed, { breaks: true }), filePath),
		{ allowAssetProtocol: true },
	);

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

	// 改ページ判定は renderer 側で生成した HTML の meta tag (scripta-pdf-smart-level /
	// criterion / force-level) を main 側 page-break-script が読み取り、見出しに inline
	// `break-before: page` を実 layout 基準で注入する hybrid 設計 (#93)。renderer は
	// 上位レベルの force-break CSS と meta tag emit までを担当する。
	await exportPdf(html, savePath);
	return true;
}

// 96 CSS px per inch × 25400 μm per inch = 25400/96 μm per px。
// SlidePreview の論理サイズ (1280×720 px) と printToPDF の pageSize (μm) を
// 1:1 に対応させ、スライド 1 枚 = PDF 1 ページの WYSIWYG を保証する。
const MICRONS_PER_PX = 25400 / 96;

// preview / 発表モードの `.slide-theme-*` (src/index.css:585-604) と 1:1 一致させる。
// CSS 側は CSS 変数上書き / こちらは PDF 用に静的 HTML を吐くため値を JS 側でも保持。
// どちらか変更する時は両方を揃える (WYSIWYG 契約)。link 色も preview の
// `--color-text-link` と揃えて dark deck のリンク視認性を保つ。
const SLIDE_PDF_PALETTE: Record<
	SlideTheme,
	{
		bg: string;
		text: string;
		codeBg: string;
		tableBorder: string;
		thBg: string;
		link: string;
	}
> = {
	light: {
		bg: "#ffffff",
		text: "#333333",
		codeBg: "#f8f8f8",
		tableBorder: "#e8e8e8",
		thBg: "#f8f8f8",
		link: "#2563eb",
	},
	dark: {
		bg: "#1a1a1a",
		text: "#d4d4d4",
		codeBg: "#222222",
		tableBorder: "#333333",
		thBg: "#222222",
		link: "#60a5fa",
	},
};

function buildSlideHtmlDocument(
	slides: string[],
	title: string,
	theme: SlideTheme = "light",
): string {
	// 各スライドを固定 1280×720 の section に格納。最後以外は break-after: page で
	// 明示的にページ送り (`:not(:last-child)` で最終 slide の余分な空白ページを回避)。
	const sections = slides.map((html) => `<section class="slide">\n${html}\n</section>`).join("\n");

	const p = SLIDE_PDF_PALETTE[theme];

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${katexInlineCss}</style>
<style>
:root { color-scheme: ${theme}; }
html, body {
  margin: 0;
  padding: 0;
  background: ${p.bg};
  color: ${p.text};
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.6;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.slide {
  width: ${SLIDE_LOGICAL_WIDTH}px;
  height: ${SLIDE_LOGICAL_HEIGHT}px;
  padding: ${SLIDE_LOGICAL_PADDING_PX}px;
  box-sizing: border-box;
  overflow: hidden;
}
.slide:not(:last-child) {
  break-after: page;
  page-break-after: always;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 0 0 0.4em; }
h1 { font-size: 2em; font-weight: 700; }
h2 { font-size: 1.6em; font-weight: 700; }
h3 { font-size: 1.3em; font-weight: 600; }
p { margin: 0.6em 0; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; }
pre { padding: 0.8em 1em; background: ${p.codeBg}; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 0.5em 0; }
th, td { border: 1px solid ${p.tableBorder}; padding: 0.4em 0.7em; }
th { background: ${p.thBg}; font-weight: 600; }
a { color: ${p.link}; text-decoration: underline; }
.mermaid-diagram { text-align: center; margin: 0.5em 0; }
.mermaid-diagram svg, .mermaid-diagram img { max-width: 100%; height: auto; }
ul, ol { padding-left: 1.5em; margin: 0.5em 0; }
/* @page size のみ指定。margin は printToPDF の marginsInches:0 で担保するので不要。 */
@page { size: ${SLIDE_LOGICAL_WIDTH}px ${SLIDE_LOGICAL_HEIGHT}px; }
</style>
</head>
<body>
${sections}
</body>
</html>`;
}

/**
 * スライド Markdown を 16:9 (1280×720 論理サイズ) の PDF としてエクスポートする。
 * 1 スライド = 1 ページ。SlidePreview と同じ論理寸法・padding を使うことで、
 * プレビュー通りの WYSIWYG になる (#4)。
 * @returns save ダイアログでキャンセルされた場合は false
 */
export async function exportSlidesAsPdf(markdown: string, filePath: string): Promise<boolean> {
	const title = extractTitle(filePath);
	const defaultName = `${title}-slides.pdf`;

	const savePath = await showSaveDialog({
		defaultPath: defaultName,
		filters: [{ name: "PDF", extensions: ["pdf"] }],
	});
	if (!savePath) return false;

	const sections = parseSlides(markdown);
	// Fable #12: frontmatter `theme:` があれば PDF もそれに従う。無ければ従来通り light
	// (印刷デフォルト)。preview / 発表 / PDF の 3 経路で同じ theme が効く WYSIWYG 契約。
	const slideTheme = extractSlideFrontmatterTheme(markdown) ?? "light";
	// SlidePreview / 発表モードと共通の `renderSlideHtmlWithMermaid` を通し、
	// 「末尾 `---` 除去 → 空スライドは空文字 → mermaid preprocess → markdownToHtml →
	// image src 解決」の順序と契約を preview / presentation / PDF export で一致させる。
	// PDF 経路のみ mermaid を SVG→PNG rasterize させて印刷の SVG quirk を bypass (#106)。
	// breaks オプションは SlidePreview と揃える (default = false)。ExportDialog の
	// 「プレビュー通りの見た目」文言と WYSIWYG 契約を保つため、単一改行を <br> に
	// 変えない (通常 PDF export では `breaks: true` を使うが、スライドでは preview の
	// 挙動を優先)。
	const slidesHtml = await Promise.all(
		sections.map((slide) =>
			renderSlideHtmlWithMermaid(slide.content, filePath, slideTheme, {
				mermaidOptions: { htmlLabels: false, useMaxWidth: false },
				embedOptions: { rasterize: true },
			}),
		),
	);

	const html = buildSlideHtmlDocument(slidesHtml, title, slideTheme);

	await exportPdf(html, savePath, {
		pageSize: {
			width: Math.round(SLIDE_LOGICAL_WIDTH * MICRONS_PER_PX),
			height: Math.round(SLIDE_LOGICAL_HEIGHT * MICRONS_PER_PX),
		},
		marginsInches: { top: 0, bottom: 0, left: 0, right: 0 },
		skipSectionBreakScript: true,
	});
	return true;
}

export { buildFence } from "./code-fence";
export { getDefaultPromptTemplate } from "./export-templates";

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
