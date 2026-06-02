/**
 * PDF エクスポート関連の型 (#93)。
 * renderer / preload / main が同一定義を共有するため `src/types/` に置く。
 */

export type PdfPageBreakLevel = 1 | 2 | 3;
export type PdfPageBreakCriterion = "compact" | "section";

export interface PdfPageBreakOptions {
	level: PdfPageBreakLevel;
	criterion: PdfPageBreakCriterion;
}
