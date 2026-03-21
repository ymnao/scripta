import yaml from "js-yaml";
import type { SlideSection } from "../types/slide";
import { CodeFenceTracker } from "./code-fence";

/**
 * 先頭 `---` ... `---` ブロックが YAML frontmatter かどうかを判定する。
 * js-yaml で試行パースし、オブジェクトとして解析できた場合のみ frontmatter とみなす。
 * @returns 閉じ `---` の行インデックス。frontmatter でなければ -1。
 */
function detectFrontmatter(lines: string[]): number {
	if (lines[0]?.trim() !== "---" || lines.length < 3) return -1;

	let closingIndex = -1;
	for (let j = 1; j < lines.length; j++) {
		if (lines[j].trim() === "---") {
			closingIndex = j;
			break;
		}
	}
	if (closingIndex < 2) return -1;

	const block = lines.slice(1, closingIndex).join("\n");
	try {
		const parsed = yaml.load(block);
		// YAML としてパースできても、プレーンな文字列やnullではなく
		// オブジェクト（key-value マッピング）の場合のみ frontmatter とみなす
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return closingIndex;
		}
	} catch {
		// パース失敗 = YAML ではない
	}
	return -1;
}

/**
 * Markdown テキストを `---` 区切りでスライドに分割する。
 * - コードブロック（``` / ~~~）内の `---` はスキップ
 * - frontmatter（先頭 `---` ... `---`）はスキップ
 * - 区切り行は前のスライドに含める
 */
export function parseSlides(text: string): SlideSection[] {
	if (text === "") {
		return [{ content: "", from: 0, to: 0 }];
	}

	const lines = text.split("\n");
	const separatorIndices: number[] = [];
	const fence = new CodeFenceTracker();
	const frontmatterEnd = detectFrontmatter(lines);

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();

		// frontmatter 範囲内はスキップ
		if (frontmatterEnd >= 0 && i <= frontmatterEnd) {
			continue;
		}

		if (fence.processLine(trimmed)) continue;

		// スライド区切り: `---` のみの行（前後の空白は許容）
		if (trimmed === "---") {
			separatorIndices.push(i);
		}
	}

	if (separatorIndices.length === 0) {
		return [{ content: text, from: 0, to: text.length }];
	}

	const slides: SlideSection[] = [];
	let slideStart = 0;

	// 各行の開始オフセットを事前計算
	const lineOffsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineOffsets.push(offset);
		offset += line.length + 1; // +1 for \n
	}

	for (const sepLineIndex of separatorIndices) {
		// 区切り行の終端（区切り行を含む）
		const sepLineEnd = lineOffsets[sepLineIndex] + lines[sepLineIndex].length;

		slides.push({
			content: text.slice(slideStart, sepLineEnd),
			from: slideStart,
			to: sepLineEnd,
		});

		// 次のスライドは区切り行の次の行から
		slideStart = sepLineEnd + 1; // +1 for \n after separator
	}

	// 最後のスライド（最後の区切り以降）
	if (slideStart <= text.length) {
		slides.push({
			content: text.slice(slideStart),
			from: slideStart,
			to: text.length,
		});
	}

	return slides;
}

/**
 * カーソル位置からスライドのインデックスを特定する。
 */
export function findSlideAtCursor(slides: SlideSection[], cursorPos: number): number {
	for (let i = slides.length - 1; i >= 0; i--) {
		if (cursorPos >= slides[i].from) {
			return i;
		}
	}
	return 0;
}
