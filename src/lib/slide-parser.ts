import { load } from "js-yaml";
import type { SlideSection, SlideTheme } from "../types/slide";
import { CodeFenceTracker } from "./code-fence";

/**
 * 先頭 `---` ... `---` ブロックを YAML frontmatter として解析する。
 * js-yaml で試行パースし、オブジェクト (key-value マッピング) の場合のみ frontmatter とみなす。
 * @returns 閉じ `---` の行インデックスと解析済みオブジェクト。frontmatter でなければ null。
 */
function parseFrontmatterBlock(
	lines: string[],
): { endIndex: number; data: Record<string, unknown> } | null {
	if (lines[0]?.trim() !== "---" || lines.length < 3) return null;

	let closingIndex = -1;
	for (let j = 1; j < lines.length; j++) {
		if (lines[j].trim() === "---") {
			closingIndex = j;
			break;
		}
	}
	if (closingIndex < 2) return null;

	const block = lines.slice(1, closingIndex).join("\n");
	try {
		const parsed = load(block);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { endIndex: closingIndex, data: parsed as Record<string, unknown> };
		}
	} catch {
		// パース失敗 = YAML ではない
	}
	return null;
}

/**
 * スライド deck の YAML frontmatter から `theme: "light" | "dark"` を抽出する (Fable #12)。
 * frontmatter が無い / theme フィールドが無い / 値が SlideTheme 以外の場合は null。
 * null の場合は呼び出し側で app theme (useThemeStore) にフォールバックする。
 */
export function extractSlideFrontmatterTheme(text: string): SlideTheme | null {
	const parsed = parseFrontmatterBlock(text.split("\n"));
	if (!parsed) return null;
	const theme = parsed.data.theme;
	if (theme === "light" || theme === "dark") return theme;
	return null;
}

/**
 * Markdown テキストを `---` 区切りでスライドに分割する。
 * - コードブロック（``` / ~~~）内の `---` はスキップ
 * - frontmatter（先頭 `---` ... `---`）は 1 枚目のスライド本文からも除外する
 *   (旧実装は区切り検出のみ skip し frontmatter 本文を slide 1 に含めていたが、
 *    Fable #12 で `theme:` を書いた瞬間 preview に生の YAML が見えるので修正)
 * - 区切り行は前のスライドに含める
 */
export function parseSlides(text: string): SlideSection[] {
	if (text === "") {
		return [{ content: "", from: 0, to: 0 }];
	}

	const lines = text.split("\n");
	const separatorIndices: number[] = [];
	const fence = new CodeFenceTracker();
	const frontmatterEnd = parseFrontmatterBlock(lines)?.endIndex ?? -1;

	// 各行の開始オフセットを事前計算
	const lineOffsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineOffsets.push(offset);
		offset += line.length + 1; // +1 for \n
	}
	// frontmatter 閉じ `---` の直後 (次行先頭) を本文開始点とする。frontmatter が
	// 末尾まで占める (frontmatterEnd === lines.length - 1) 場合は text.length。
	const bodyStart = frontmatterEnd >= 0 ? (lineOffsets[frontmatterEnd + 1] ?? text.length) : 0;

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
		return [{ content: text.slice(bodyStart), from: bodyStart, to: text.length }];
	}

	const slides: SlideSection[] = [];
	let slideStart = bodyStart;

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
