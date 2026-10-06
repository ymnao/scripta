import { syntaxTree } from "@codemirror/language";
import {
	EditorSelection,
	type EditorState,
	StateEffect,
	StateField,
	Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { escapeTableCell, findUnescapedPipe, trimToLastTableLine } from "./table-utils";

// ── Effects ───────────────────────────────────────────

// テーブルセル（widget 内の contentEditable）へ実フォーカスが入った/外れたを CM state に
// 持ち込む effect。gap 判定（tableGapCursorLayer / tableGapActiveClass）がセル編集中かを
// 知るために使う。詳細は tableCellFocusField の JSDoc 参照（#167）。
export const setCellFocusEffect = StateEffect.define<boolean>();

// ── Types ─────────────────────────────────────────────

interface CellData {
	content: string;
}

interface RowData {
	kind: "header" | "data";
	cells: CellData[];
}

type Alignment = "left" | "center" | "right";

export interface TableData {
	rows: RowData[];
	alignments: Alignment[];
}

// ── Cell selection ───────────────────────────────────

interface CellCoord {
	row: number;
	col: number;
}

interface CellSelection {
	anchor: CellCoord;
	head: CellCoord;
}

export const cellSelectionMap = new WeakMap<HTMLElement, CellSelection>();

let dragState: {
	wrapper: HTMLElement;
	view: EditorView;
	anchor: CellCoord;
	mode: "pending" | "cells" | "cross-boundary";
} | null = null;

// ── Parsing ───────────────────────────────────────────

export function parseRowCells(text: string): string[] {
	const cells: string[] = [];
	let i = 0;
	if (text[0] === "|") i = 1;
	while (i < text.length) {
		const pipeIdx = findUnescapedPipe(text, i);
		const segEnd = pipeIdx === -1 ? text.length : pipeIdx;
		cells.push(text.slice(i, segEnd).trim());
		if (pipeIdx === -1) break;
		i = pipeIdx + 1;
		if (i >= text.length) break;
	}
	return cells;
}

export const delimiterRowRe = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function parseAlignments(text: string): Alignment[] {
	return parseRowCells(text).map((c) => {
		if (c.startsWith(":") && c.endsWith(":")) return "center";
		if (c.endsWith(":")) return "right";
		return "left";
	});
}

export function parseTableFromLines(lines: string[]): TableData | null {
	const rows: RowData[] = [];
	let alignments: Alignment[] = [];
	let delimiterSeen = false;

	for (const line of lines) {
		if (!delimiterSeen && delimiterRowRe.test(line)) {
			delimiterSeen = true;
			alignments = parseAlignments(line);
			continue;
		}
		rows.push({
			kind: delimiterSeen ? "data" : "header",
			cells: parseRowCells(line).map((c) => ({ content: c })),
		});
	}

	if (!delimiterSeen || rows.length < 2) return null;
	return { rows, alignments };
}

// ── Helpers ───────────────────────────────────────────

function findTableNode(
	state: EditorState,
	pos: number,
): { from: number; to: number; startLine: number; endLine: number } | null {
	const tree = syntaxTree(state);
	for (const offset of [0, 1, -1]) {
		const p = pos + offset;
		if (p < 0 || p > state.doc.length) continue;
		let node = tree.resolve(p, 1);
		while (node) {
			if (node.name === "Table") {
				const startLine = state.doc.lineAt(node.from).number;
				const endLine = trimToLastTableLine(state.doc, startLine, state.doc.lineAt(node.to).number);
				return {
					from: node.from,
					to: state.doc.line(endLine).to,
					startLine,
					endLine,
				};
			}
			if (!node.parent) break;
			node = node.parent;
		}
	}
	return null;
}

/** セルにフォーカスを移し、キャレットを内容末尾に置く。 */
export function placeCaretAtEnd(cell: HTMLElement): void {
	cell.focus();
	const range = document.createRange();
	range.selectNodeContents(cell);
	range.collapse(false);
	const sel = window.getSelection();
	sel?.removeAllRanges();
	sel?.addRange(range);
}

export function focusCell(container: HTMLElement, row: number, col: number): void {
	const cell = container.querySelector(
		`[data-row="${row}"][data-col="${col}"]`,
	) as HTMLElement | null;
	if (cell) placeCaretAtEnd(cell);
}

/** セル内の <br> を `<br>` テキストとして読み取る。ゼロ幅スペースは除去する。 */
export function getCellTextContent(el: HTMLElement): string {
	const parts: string[] = [];
	for (const node of el.childNodes) {
		if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") {
			parts.push("<br>");
		} else {
			parts.push((node.textContent || "").replace(/\u200B/g, ""));
		}
	}
	return parts.join("");
}

/** セル内容をセットする。`<br>` テキストを <br> 要素に復元する。 */
export function setCellContent(el: HTMLElement, content: string): void {
	if (!content.includes("<br>")) {
		el.textContent = content;
		return;
	}
	el.textContent = "";
	const segments = content.split("<br>");
	for (let i = 0; i < segments.length; i++) {
		if (i > 0) el.appendChild(document.createElement("br"));
		if (segments[i]) el.appendChild(document.createTextNode(segments[i]));
	}
}

/** Map widget row index → doc line offset (skip delimiter at doc index 1). */
export function widgetRowToLineOffset(widgetRow: number): number {
	return widgetRow >= 1 ? widgetRow + 1 : widgetRow;
}

// ── Cell selection helpers ───────────────────────────

function getCellRect(anchor: CellCoord, head: CellCoord) {
	return {
		minRow: Math.min(anchor.row, head.row),
		maxRow: Math.max(anchor.row, head.row),
		minCol: Math.min(anchor.col, head.col),
		maxCol: Math.max(anchor.col, head.col),
	};
}

const lastClickedCell = new WeakMap<HTMLElement, CellCoord>();

export function applyCellSelection(wrapper: HTMLElement, selection: CellSelection | null): void {
	for (const cell of wrapper.querySelectorAll(".cm-table-cell-selected")) {
		cell.classList.remove("cm-table-cell-selected");
	}
	if (!selection) {
		cellSelectionMap.delete(wrapper);
		return;
	}
	cellSelectionMap.set(wrapper, selection);
	const { minRow, maxRow, minCol, maxCol } = getCellRect(selection.anchor, selection.head);
	for (let r = minRow; r <= maxRow; r++) {
		for (let c = minCol; c <= maxCol; c++) {
			const cell = wrapper.querySelector(`[data-row="${r}"][data-col="${c}"]`);
			if (cell) cell.classList.add("cm-table-cell-selected");
		}
	}
}

export function clearCellSelection(wrapper: HTMLElement): void {
	applyCellSelection(wrapper, null);
}

export function hasMultiCellSelection(wrapper: HTMLElement): boolean {
	const sel = cellSelectionMap.get(wrapper);
	if (!sel) return false;
	return sel.anchor.row !== sel.head.row || sel.anchor.col !== sel.head.col;
}

function getCellPlainText(el: HTMLElement): string {
	const parts: string[] = [];
	for (const node of el.childNodes) {
		if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") {
			parts.push("\n");
		} else {
			parts.push((node.textContent || "").replace(/​/g, ""));
		}
	}
	return parts.join("").replace(/\n$/, "");
}

function tsvQuote(value: string): string {
	if (value.includes("\t") || value.includes("\n") || value.includes('"')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function getSelectedCellsText(wrapper: HTMLElement): string | null {
	const sel = cellSelectionMap.get(wrapper);
	if (!sel) return null;
	const { minRow, maxRow, minCol, maxCol } = getCellRect(sel.anchor, sel.head);
	const lines: string[] = [];
	for (let r = minRow; r <= maxRow; r++) {
		const cells: string[] = [];
		for (let c = minCol; c <= maxCol; c++) {
			const cell = wrapper.querySelector(
				`[data-row="${r}"][data-col="${c}"]`,
			) as HTMLElement | null;
			cells.push(tsvQuote(cell ? getCellPlainText(cell) : ""));
		}
		lines.push(cells.join("\t"));
	}
	return lines.join("\n");
}

export function parseTsv(text: string): string[][] {
	const rows: string[][] = [];
	let pos = 0;

	while (pos <= text.length) {
		const row: string[] = [];

		while (true) {
			let value: string;
			if (pos < text.length && text[pos] === '"') {
				pos++;
				let buf = "";
				while (pos < text.length) {
					if (text[pos] === '"') {
						if (pos + 1 < text.length && text[pos + 1] === '"') {
							buf += '"';
							pos += 2;
						} else {
							pos++;
							break;
						}
					} else {
						buf += text[pos++];
					}
				}
				value = buf;
			} else {
				const start = pos;
				while (
					pos < text.length &&
					text[pos] !== "\t" &&
					text[pos] !== "\n" &&
					text[pos] !== "\r"
				) {
					pos++;
				}
				value = text.slice(start, pos);
			}
			row.push(value);

			if (pos >= text.length || text[pos] !== "\t") break;
			pos++;
		}

		rows.push(row);
		if (pos >= text.length) break;
		if (text[pos] === "\r") pos++;
		if (pos < text.length && text[pos] === "\n") pos++;
	}

	if (rows.length > 1) {
		const last = rows[rows.length - 1];
		if (last.length === 1 && last[0] === "") rows.pop();
	}
	return rows;
}

// DOM 上の指定行を読み取り、markdown 行との差分を 1 トランザクションで反映する。
// pasteTsvGrid / clearSelectedCellContents の共通バックエンド。
function syncRowsToDoc(wrapper: HTMLElement, view: EditorView, rows: number[]): void {
	const tableNode = getTableNodeFor(view, wrapper);
	if (!tableNode) return;
	const changes: { from: number; to: number; insert: string }[] = [];
	for (const r of rows) {
		const lineOffset = widgetRowToLineOffset(r);
		const lineNum = tableNode.startLine + lineOffset;
		if (lineNum > view.state.doc.lines) continue;
		const docLine = view.state.doc.line(lineNum);
		const trEl = wrapper.querySelectorAll("tr")[r];
		if (!trEl) continue;
		const cellContents: string[] = [];
		for (const td of trEl.querySelectorAll("th, td")) {
			cellContents.push(escapeTableCell(getCellTextContent(td as HTMLElement)));
		}
		const newLine = `| ${cellContents.join(" | ")} |`;
		if (newLine !== view.state.doc.sliceString(docLine.from, docLine.to)) {
			changes.push({ from: docLine.from, to: docLine.to, insert: newLine });
		}
	}
	if (changes.length > 0) {
		anchorEditorToTable(view, tableNode);
		view.dispatch({ changes });
	}
}

function pasteTsvGrid(
	wrapper: HTMLElement,
	view: EditorView,
	grid: string[][],
	startRow: number,
	startCol: number,
): void {
	const data = getDataFor(wrapper);
	if (!data) return;
	const maxRow = data.rows.length - 1;
	const maxCol = colCountOf(data) - 1;

	const affectedRows: number[] = [];
	for (let r = 0; r < grid.length; r++) {
		const tr = startRow + r;
		if (tr > maxRow) break;
		for (let c = 0; c < grid[r].length; c++) {
			const tc = startCol + c;
			if (tc > maxCol) break;
			const cell = wrapper.querySelector(
				`[data-row="${tr}"][data-col="${tc}"]`,
			) as HTMLElement | null;
			if (cell) setCellContent(cell, grid[r][c].replace(/\n/g, "<br>"));
		}
		affectedRows.push(tr);
	}

	syncRowsToDoc(wrapper, view, affectedRows);
}

export function clearSelectedCellContents(wrapper: HTMLElement, view: EditorView): void {
	const sel = cellSelectionMap.get(wrapper);
	if (!sel) return;
	const { minRow, maxRow, minCol, maxCol } = getCellRect(sel.anchor, sel.head);

	for (let r = minRow; r <= maxRow; r++) {
		for (let c = minCol; c <= maxCol; c++) {
			const cell = wrapper.querySelector(
				`[data-row="${r}"][data-col="${c}"]`,
			) as HTMLElement | null;
			if (cell) cell.textContent = "";
		}
	}

	const rows: number[] = [];
	for (let r = minRow; r <= maxRow; r++) rows.push(r);
	syncRowsToDoc(wrapper, view, rows);
}

export function cellCoordFromElement(el: Element | null): CellCoord | null {
	const cell = el?.closest?.("[data-row][data-col]") as HTMLElement | null;
	if (!cell) return null;
	return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
}

export function applyPasteText(
	wrapper: HTMLElement,
	view: EditorView,
	text: string,
	coord: CellCoord,
	replaceCell = false,
): void {
	if (text.includes("\t")) {
		pasteTsvGrid(wrapper, view, parseTsv(text), coord.row, coord.col);
	} else {
		const sanitized = sanitizePasteText(text);
		if (!sanitized) return;
		const target = wrapper.querySelector(
			`[data-row="${coord.row}"][data-col="${coord.col}"]`,
		) as HTMLElement | null;
		if (!target) return;
		if (replaceCell) target.textContent = "";
		pasteIntoCell(target, sanitized, view, wrapper);
	}
}

// ── Drag selection ───────────────────────────────────

export function handleCellMouseDown(e: MouseEvent, view: EditorView, wrapper: HTMLElement): void {
	if (e.button !== 0) return;
	const coord = cellCoordFromElement(e.target as Element);
	if (!coord) return;

	if (e.shiftKey) {
		e.preventDefault();
		const existing = cellSelectionMap.get(wrapper);
		const anchor = existing?.anchor ?? lastClickedCell.get(wrapper) ?? coord;
		applyCellSelection(wrapper, { anchor, head: coord });
		return;
	}

	clearCellSelection(wrapper);
	lastClickedCell.set(wrapper, coord);

	dragState = { wrapper, view, anchor: coord, mode: "pending" };

	const onMouseMove = (ev: MouseEvent) => {
		if (!dragState || dragState.wrapper !== wrapper) return;

		const target = document.elementFromPoint(ev.clientX, ev.clientY);
		const inTable = target && (wrapper.contains(target) || wrapper === target);

		if (inTable) {
			const headCoord = cellCoordFromElement(target);

			if (dragState.mode === "pending") {
				if (!headCoord) return;
				if (headCoord.row === dragState.anchor.row && headCoord.col === dragState.anchor.col)
					return;
				dragState.mode = "cells";
				window.getSelection()?.removeAllRanges();
			}

			if (dragState.mode === "cells" || dragState.mode === "cross-boundary") {
				if (headCoord) {
					dragState.mode = "cells";
					applyCellSelection(wrapper, { anchor: dragState.anchor, head: headCoord });
				}
			}
		} else {
			if (dragState.mode === "pending" || dragState.mode === "cells") {
				dragState.mode = "cross-boundary";
				clearCellSelection(wrapper);
				(document.activeElement as HTMLElement)?.blur();
			}

			const tableNode = getTableNodeFor(view, wrapper);
			if (!tableNode) return;

			const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
			if (pos === null) return;

			const tableFrom = view.state.doc.line(tableNode.startLine).from;
			const tableTo = view.state.doc.line(tableNode.endLine).to;
			const anchor = pos < tableFrom ? tableTo : tableFrom;
			view.dispatch({ selection: EditorSelection.range(anchor, pos) });
			view.focus();
		}
	};

	const onMouseUp = () => {
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
		dragState = null;
	};

	document.addEventListener("mousemove", onMouseMove);
	document.addEventListener("mouseup", onMouseUp);
}

// ── Widget registry ──────────────────────────────────

export const widgetPositions = new WeakMap<HTMLElement, number>();
/** Stores current TableData per wrapper element so event handlers always
 *  read up-to-date data (updateDOM is called on a NEW widget instance,
 *  but the event listeners were attached by the OLD instance's buildDOM). */
export const widgetDataMap = new WeakMap<HTMLElement, TableData>();

export function getDataFor(wrapperEl: HTMLElement): TableData | null {
	return widgetDataMap.get(wrapperEl) ?? null;
}

export function colCountOf(data: TableData): number {
	return Math.max(...data.rows.map((r) => r.cells.length), data.alignments.length);
}

export function emptyRow(data: TableData): string {
	return `| ${new Array(colCountOf(data)).fill("  ").join(" | ")} |`;
}

export function getTableNodeFor(view: EditorView, wrapperEl: HTMLElement) {
	const pos = widgetPositions.get(wrapperEl);
	if (pos === undefined) return null;
	return findTableNode(view.state, pos);
}

// undo 時のカーソル復元先がテーブル付近になるよう、changes dispatch の前に
// CM6 の選択位置をテーブル先頭へ移動する（history には載せない）。
function anchorEditorToTable(view: EditorView, tableNode: { startLine: number }): void {
	const anchor = view.state.doc.line(tableNode.startLine).from;
	if (view.state.selection.main.head === anchor) return;
	view.dispatch({
		selection: EditorSelection.cursor(anchor),
		annotations: Transaction.addToHistory.of(false),
	});
}

export function exitTableDown(view: EditorView, wrapperEl: HTMLElement): void {
	(document.activeElement as HTMLElement)?.blur();
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	// テーブル末尾境界に selection を置くと、中間境界なら tableCursorFilter が次行先頭へ
	// 退避し、文書末尾なら EOF gap として文書を変えずに留まる（#167）。
	view.dispatch({ selection: { anchor: view.state.doc.line(tableNode.endLine).to } });
	view.focus();
}

export function exitTableUp(view: EditorView, wrapperEl: HTMLElement): void {
	(document.activeElement as HTMLElement)?.blur();
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	// テーブル先頭境界に selection を置くと、中間境界なら tableCursorFilter が前行末尾へ
	// 退避し、文書先頭なら BOF gap として文書を変えずに留まる（#167、exitTableDown と対称）。
	view.dispatch({ selection: { anchor: view.state.doc.line(tableNode.startLine).from } });
	view.focus();
}

// ── DOM → doc sync ───────────────────────────────────

/**
 * セルの属する行を DOM から読み取り、対応するドキュメント行へ反映する。
 *
 * @param fromTyping ユーザーの直接入力起点なら true。"input.type" 注釈を付けて CM の
 *   history を通常タイピングと同様に扱わせ（連続入力を 1 group にまとめる）、dispatch 後
 *   に再構築されるセル DOM へキャレットをセル末尾で再フォーカスする。paste 等は false。
 */
export function syncRowFromCell(
	cell: HTMLElement,
	view: EditorView,
	wrapperEl: HTMLElement,
	fromTyping = false,
): void {
	const rowIdx = Number(cell.dataset.row);
	if (Number.isNaN(rowIdx)) return;

	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const lineOffset = widgetRowToLineOffset(rowIdx);
	const lineNum = tableNode.startLine + lineOffset;
	if (lineNum > view.state.doc.lines) return;

	const docLine = view.state.doc.line(lineNum);
	const tr = cell.closest("tr");
	if (!tr) return;

	const cellContents: string[] = [];
	for (const td of tr.querySelectorAll("th, td")) {
		cellContents.push(escapeTableCell(getCellTextContent(td as HTMLElement)));
	}

	const newLine = `| ${cellContents.join(" | ")} |`;
	if (newLine === view.state.doc.sliceString(docLine.from, docLine.to)) return;

	view.dispatch({
		changes: { from: docLine.from, to: docLine.to, insert: newLine },
		// 連続入力を 1 つの undo グループにまとめる（注釈が無いと history のグループ化が
		// 表外の編集と混じって崩れ、最後の入力が history に積まれず "前の修正" が undo
		// される現象が起きる）。
		...(fromTyping ? { annotations: Transaction.userEvent.of("input.type") } : {}),
	});

	if (!fromTyping) return;

	// dispatch でウィジェット DOM が再構築されるとセルの DOM フォーカスが失われ、次の
	// キーストロークが行方不明になる。連続入力を継続できるよう、同座標のセルへ
	// フォーカスを戻し、キャレットをセル末尾に置く（入力直後の自然な位置）。
	focusCell(wrapperEl, rowIdx, Number(cell.dataset.col));
}

/** ペーストテキストを単一セル用に正規化する（`|` 除去 / 改行→スペース）。 */
export function sanitizePasteText(raw: string): string {
	return raw.replace(/\|/g, "").replace(/[\r\n]+/g, " ");
}

/** 正規化済みテキストをセルへ挿入し、ドキュメントへ反映する。 */
export function pasteIntoCell(
	cell: HTMLElement,
	sanitized: string,
	view: EditorView,
	wrapperEl: HTMLElement,
): void {
	const sel = window.getSelection();
	// 選択が対象セル内に完全に収まっている場合のみ caret 位置へ挿入する。
	// anchor / focus どちらかがセル外（セルをまたぐ選択）だと deleteContents が
	// 他セルの DOM まで巻き込み、syncRowFromCell が 1 行しか同期しないため
	// DOM と Markdown が不整合になる。その場合は対象セル末尾への追記に倒す。
	const withinCell =
		sel !== null &&
		sel.rangeCount > 0 &&
		sel.anchorNode !== null &&
		sel.focusNode !== null &&
		cell.contains(sel.anchorNode) &&
		cell.contains(sel.focusNode);
	if (withinCell) {
		const range = sel.getRangeAt(0);
		range.deleteContents();
		const node = document.createTextNode(sanitized);
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
	} else {
		// セルをまたぐ選択 / セル外 / 選択なし → 対象セル末尾へ追記
		cell.appendChild(document.createTextNode(sanitized));
	}
	syncRowFromCell(cell, view, wrapperEl);
}

/**
 * テーブルセル（widget 内の contentEditable）に実フォーカスがあるかを保持する field（#167）。
 *
 * 文書先頭/末尾がテーブルのとき、セルをクリックして編集していても
 * `anchorEditorToTable`（undo 復元先確保のため）が CM selection をテーブル先頭境界
 *（文書先頭テーブルなら 0 = BOF gap）に置く。このため selection だけでは「セル編集中」と
 *「gap にカーソルがいる」を区別できず、セル編集中ずっと gap 判定が真になって
 * gap cursor バー（.cm-table-gap-cursor）や .cm-table-gap-active が出てしまう。
 *
 * 描画時に `document.activeElement` を直接読む案は、エディタ未フォーカスから
 * セルを直接クリックした場合に CM の update が一切起きず再評価されないため不採用。
 * 代わりにセルの focusin / focusout を effect で field に持ち込み、gap 判定側で
 * この field が true のときは gap 描画を抑制する。
 */
export const tableCellFocusField = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setCellFocusEffect)) return e.value;
		}
		return value;
	},
});
