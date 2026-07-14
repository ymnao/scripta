/**
 * PDF export IPC の optional 追加パラメータ。
 * default (undefined) は A4 + 20mm margin + section break script 実行 (通常の Markdown PDF)。
 * スライド export は pageSize を論理寸法、marginsInches を 0、skipSectionBreakScript を true にする。
 */
export interface PdfExportOptions {
	/** printToPDF の pageSize (micron 単位)。省略時は A4 preset。 */
	pageSize?: { width: number; height: number };
	/** printToPDF の margins (inch 単位)。省略時は 20mm 換算 (~0.787 inch)。 */
	marginsInches?: { top: number; bottom: number; left: number; right: number };
	/**
	 * `<h*>` に inline break-before を注入する section-break-script の実行を skip する。
	 * スライドは自前で `page-break-after: always` を持つので不要。default false。
	 */
	skipSectionBreakScript?: boolean;
}
