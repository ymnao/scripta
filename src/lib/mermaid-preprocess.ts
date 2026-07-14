import { type MermaidRenderOptions, renderMermaid } from "./mermaid";
import { svgToPng } from "./svg-rasterize";

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
