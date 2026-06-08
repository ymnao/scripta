import { syntaxTree } from "@codemirror/language";
import {
	EditorSelection,
	EditorState,
	type Extension,
	type Range,
	StateEffect,
	StateField,
	Transaction,
	type TransactionSpec,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { findUnescapedPipe, trimToLastTableLine } from "./table-utils";

// ── Effects ───────────────────────────────────────────

export const focusTableCellEffect = StateEffect.define<{
	tableFrom: number;
	row: number;
	col: number;
}>();

const rebuildTableDecos = StateEffect.define<null>();

// ── Types ─────────────────────────────────────────────

interface CellData {
	content: string;
}

interface RowData {
	kind: "header" | "data";
	cells: CellData[];
}

type Alignment = "left" | "center" | "right";

interface TableData {
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

const cellSelectionMap = new WeakMap<HTMLElement, CellSelection>();

let dragState: {
	wrapper: HTMLElement;
	view: EditorView;
	anchor: CellCoord;
	mode: "pending" | "cells" | "cross-boundary";
} | null = null;

// ── Parsing ───────────────────────────────────────────

function parseRowCells(text: string): string[] {
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

const delimiterRowRe = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function parseAlignments(text: string): Alignment[] {
	return parseRowCells(text).map((c) => {
		if (c.startsWith(":") && c.endsWith(":")) return "center";
		if (c.endsWith(":")) return "right";
		return "left";
	});
}

function parseTableFromLines(lines: string[]): TableData | null {
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

/** セル内容を正規化する。`|` をエスケープし改行を除去する。 */
function sanitizeCellText(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** セル内の <br> を `<br>` テキストとして読み取る。ゼロ幅スペースは除去する。 */
function getCellTextContent(el: HTMLElement): string {
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
function setCellContent(el: HTMLElement, content: string): void {
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
function widgetRowToLineOffset(widgetRow: number): number {
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

function applyCellSelection(wrapper: HTMLElement, selection: CellSelection | null): void {
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

function hasMultiCellSelection(wrapper: HTMLElement): boolean {
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

function getSelectedCellsText(wrapper: HTMLElement): string | null {
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
			cellContents.push(sanitizeCellText(getCellTextContent(td as HTMLElement)));
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

function clearSelectedCellContents(wrapper: HTMLElement, view: EditorView): void {
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

function cellCoordFromElement(el: Element | null): CellCoord | null {
	const cell = el?.closest?.("[data-row][data-col]") as HTMLElement | null;
	if (!cell) return null;
	return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
}

function applyPasteText(
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

function handleCellMouseDown(e: MouseEvent, view: EditorView, wrapper: HTMLElement): void {
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

// ── Widget ────────────────────────────────────────────

const widgetPositions = new WeakMap<HTMLElement, number>();
/** Stores current TableData per wrapper element so event handlers always
 *  read up-to-date data (updateDOM is called on a NEW widget instance,
 *  but the event listeners were attached by the OLD instance's buildDOM). */
const widgetDataMap = new WeakMap<HTMLElement, TableData>();
let pendingFocus: { tableFrom: number; row: number; col: number } | null = null;

/** IME 状態追跡（ウィジェット単位）。compositionActive はコンポジション中に true。
 *  composing は compositionstart で true になり、compositionend 後の
 *  最初の keyup で false になる。これにより確定 Enter の keydown を
 *  確実にスキップできる。 */
const compositionState = new WeakMap<HTMLElement, { active: boolean; composing: boolean }>();

function getCompositionState(el: HTMLElement) {
	return compositionState.get(el) ?? { active: false, composing: false };
}

function getDataFor(wrapperEl: HTMLElement): TableData | null {
	return widgetDataMap.get(wrapperEl) ?? null;
}

function colCountOf(data: TableData): number {
	return Math.max(...data.rows.map((r) => r.cells.length), data.alignments.length);
}

function emptyRow(data: TableData): string {
	return `| ${new Array(colCountOf(data)).fill("  ").join(" | ")} |`;
}

function getTableNodeFor(view: EditorView, wrapperEl: HTMLElement) {
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

	const { doc } = view.state;
	const belowLineNum = tableNode.endLine + 1;

	if (belowLineNum <= doc.lines) {
		// テーブル直下に行（空行 / 本文）がある: その行頭へ移動する（挿入しない）。
		// 本文が密着していても巻き込まず、本文行頭へ抜ける。
		view.dispatch({ selection: { anchor: doc.line(belowLineNum).from } });
	} else {
		// EOF（直下に行が無い）: 改行を 1 つ補って行を作りその行頭へ
		const endTo = doc.line(tableNode.endLine).to;
		view.dispatch({
			changes: { from: endTo, insert: "\n" },
			selection: { anchor: endTo + 1 },
		});
	}
	view.focus();
}

function exitTableUp(view: EditorView, wrapperEl: HTMLElement): void {
	(document.activeElement as HTMLElement)?.blur();
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (tableNode) {
		const startLinePos = view.state.doc.line(tableNode.startLine).from;
		const before = Math.max(startLinePos - 1, 0);
		view.dispatch({ selection: { anchor: before } });
		view.focus();
	}
}

class EditableTableWidget extends WidgetType {
	data: TableData;
	tableFrom: number;
	constructor(data: TableData, tableFrom: number) {
		super();
		this.data = data;
		this.tableFrom = tableFrom;
	}

	eq(other: EditableTableWidget): boolean {
		if (this.tableFrom !== other.tableFrom) return false;
		const a = this.data;
		const b = other.data;
		if (a.alignments.length !== b.alignments.length) return false;
		for (let i = 0; i < a.alignments.length; i++) {
			if (a.alignments[i] !== b.alignments[i]) return false;
		}
		if (a.rows.length !== b.rows.length) return false;
		for (let r = 0; r < a.rows.length; r++) {
			if (a.rows[r].cells.length !== b.rows[r].cells.length) return false;
			for (let c = 0; c < a.rows[r].cells.length; c++) {
				if (a.rows[r].cells[c].content !== b.rows[r].cells[c].content) return false;
			}
		}
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const wrapper = this.buildDOM(view);
		widgetPositions.set(wrapper, this.tableFrom);
		widgetDataMap.set(wrapper, this.data);

		if (pendingFocus && pendingFocus.tableFrom === this.tableFrom) {
			const focus = pendingFocus;
			pendingFocus = null;
			requestAnimationFrame(() => focusCell(wrapper, focus.row, focus.col));
		}

		return wrapper;
	}

	updateDOM(dom: HTMLElement, _view: EditorView): boolean {
		widgetPositions.set(dom, this.tableFrom);
		widgetDataMap.set(dom, this.data);
		dom.dataset.tableFrom = String(this.tableFrom);

		const tableEl = dom.querySelector("table");
		if (!tableEl) return false;

		const { rows, alignments } = this.data;
		const colCount = Math.max(...rows.map((r) => r.cells.length), alignments.length);
		const existingTrs = Array.from(tableEl.querySelectorAll(":scope > tr"));

		while (existingTrs.length < rows.length) {
			const idx = existingTrs.length;
			const tr = document.createElement("tr");
			const isHeader = rows[idx].kind === "header";
			for (let c = 0; c < colCount; c++) {
				const cell = document.createElement(isHeader ? "th" : "td");
				cell.className = "cm-table-cell";
				cell.contentEditable = "true";
				cell.dataset.row = String(idx);
				cell.dataset.col = String(c);
				if (c < alignments.length) cell.style.textAlign = alignments[c];
				tr.appendChild(cell);
			}
			tableEl.appendChild(tr);
			existingTrs.push(tr);
		}
		while (existingTrs.length > rows.length) {
			existingTrs.pop()?.remove();
		}

		for (let r = 0; r < rows.length; r++) {
			const row = rows[r];
			const tr = existingTrs[r];
			const cells = Array.from(tr.querySelectorAll("th, td")) as HTMLElement[];

			while (cells.length < colCount) {
				const isHeader = row.kind === "header";
				const cell = document.createElement(isHeader ? "th" : "td");
				cell.className = "cm-table-cell";
				cell.contentEditable = "true";
				cell.dataset.row = String(r);
				cell.dataset.col = String(cells.length);
				if (cells.length < alignments.length) cell.style.textAlign = alignments[cells.length];
				tr.appendChild(cell);
				cells.push(cell);
			}
			while (cells.length > colCount) {
				cells.pop()?.remove();
			}

			for (let c = 0; c < colCount; c++) {
				const cell = cells[c];
				cell.dataset.row = String(r);
				cell.dataset.col = String(c);
				const align = c < alignments.length ? alignments[c] : "left";
				if (cell.style.textAlign !== align) cell.style.textAlign = align;
				const content = c < row.cells.length ? row.cells[c].content : "";
				if (getCellTextContent(cell) === content) continue;
				// 「フォーカス中のセルは更新スキップ」という旧来の最適化は undo / redo で
				// セル DOM が古い内容のまま残り「Cmd+Z が効かない」ように見える深刻なバグの
				// 元になっていた。typing 経路では DOM と data が一致するのでこの分岐に
				// 入らない（idempotent）。差分があるときは必ず更新し、フォーカス中なら
				// 新内容の末尾にキャレットを置き直す。
				const wasFocused = document.activeElement === cell;
				setCellContent(cell, content);
				if (wasFocused) placeCaretAtEnd(cell);
			}
		}

		if (pendingFocus && pendingFocus.tableFrom === this.tableFrom) {
			const focus = pendingFocus;
			pendingFocus = null;
			requestAnimationFrame(() => focusCell(dom, focus.row, focus.col));
		}

		// セル選択状態を DOM 更新後に再適用（新規セル要素にクラスが欠けるのを防ぐ）
		const sel = cellSelectionMap.get(dom);
		if (sel) applyCellSelection(dom, sel);

		return true;
	}

	ignoreEvent(e: Event): boolean {
		if (e instanceof KeyboardEvent && (e.metaKey || e.ctrlKey)) {
			return false;
		}
		// undo / redo の InputEvent（Cmd+Z や Edit メニュー Undo 等が contentEditable で
		// 変換されて発火するもの）は CM6 の history() 拡張が beforeinput ハンドラとして
		// 自前で処理する。ignoreEvent=true で返すと eventBelongsToEditor が false になり
		// CM 側のハンドラが走らなくなって native の per-cell undo にフォールバックしてしまう。
		if (
			e instanceof InputEvent &&
			(e.inputType === "historyUndo" || e.inputType === "historyRedo")
		) {
			return false;
		}
		// セル外（padding 帯）のクリックはエディタに委譲し、カーソル配置を可能にする
		if (e instanceof MouseEvent) {
			const target = e.target;
			const element =
				target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
			if (!element?.closest("td, th")) {
				return false;
			}
		}
		return true;
	}

	private buildDOM(view: EditorView): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = "cm-table-widget";
		wrapper.contentEditable = "false";
		wrapper.dataset.tableFrom = String(this.tableFrom);

		const table = document.createElement("table");

		const { rows, alignments } = this.data;
		const colCount = Math.max(...rows.map((r) => r.cells.length), alignments.length);

		for (let r = 0; r < rows.length; r++) {
			const rowData = rows[r];
			const tr = document.createElement("tr");
			const isHeader = rowData.kind === "header";

			for (let c = 0; c < colCount; c++) {
				const cell = document.createElement(isHeader ? "th" : "td");
				cell.className = "cm-table-cell";
				setCellContent(cell, c < rowData.cells.length ? rowData.cells[c].content : "");
				cell.contentEditable = "true";
				cell.dataset.row = String(r);
				cell.dataset.col = String(c);
				if (c < alignments.length) cell.style.textAlign = alignments[c];
				tr.appendChild(cell);
			}
			table.appendChild(tr);
		}

		wrapper.appendChild(table);

		wrapper.addEventListener("input", (e) => handleInput(e, view, wrapper));
		wrapper.addEventListener("keydown", (e) => handleKeydown(e, view, wrapper));
		// 注: undo / redo は CM6 の history() に任せる（ignoreEvent で historyUndo /
		// historyRedo の InputEvent を CM へ通すように設定済み）。ここで beforeinput を
		// 横取りすると CM の経路と重複し、history の整合性を壊しうる。
		wrapper.addEventListener("focusout", () => handleFocusOut(wrapper));
		wrapper.addEventListener("contextmenu", (e) => showContextMenu(e as MouseEvent, view, wrapper));
		wrapper.addEventListener("mousedown", (e) => handleCellMouseDown(e, view, wrapper));
		wrapper.addEventListener("paste", (e) => {
			e.preventDefault();
			const raw = e.clipboardData?.getData("text/plain") ?? "";
			if (!raw) return;

			const sel = cellSelectionMap.get(wrapper);
			const coord = sel
				? {
						row: Math.min(sel.anchor.row, sel.head.row),
						col: Math.min(sel.anchor.col, sel.head.col),
					}
				: cellCoordFromElement(
						getFocusedCell(wrapper) ??
							(e.target instanceof Element ? e.target : null)?.closest?.("th, td") ??
							null,
					);
			const hadSelection = !!sel;
			clearCellSelection(wrapper);
			if (!coord) return;
			applyPasteText(wrapper, view, raw, coord, hadSelection);
		});
		wrapper.addEventListener("compositionstart", () => {
			compositionState.set(wrapper, { active: true, composing: true });
		});
		wrapper.addEventListener("compositionend", () => {
			const state = getCompositionState(wrapper);
			compositionState.set(wrapper, { active: false, composing: state.composing });
		});
		wrapper.addEventListener("keyup", () => {
			const state = getCompositionState(wrapper);
			if (state.composing && !state.active) {
				compositionState.delete(wrapper);
			}
		});

		return wrapper;
	}
}

// ── Event handlers (module-level, read data from widgetDataMap) ──

/**
 * セルの属する行を DOM から読み取り、対応するドキュメント行へ反映する。
 *
 * @param fromTyping ユーザーの直接入力起点なら true。"input.type" 注釈を付けて CM の
 *   history を通常タイピングと同様に扱わせ（連続入力を 1 group にまとめる）、dispatch 後
 *   に再構築されるセル DOM へキャレットをセル末尾で再フォーカスする。paste 等は false。
 */
function syncRowFromCell(
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
		cellContents.push(sanitizeCellText(getCellTextContent(td as HTMLElement)));
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

function handleInput(e: Event, view: EditorView, wrapperEl: HTMLElement): void {
	const target = e.target as HTMLElement;
	// input target が text node / <br> の場合もあるためセルへ正規化する
	const cell = target.closest?.("th, td") as HTMLElement | null;
	if (!cell) return;
	syncRowFromCell(cell, view, wrapperEl, /* fromTyping= */ true);
}

/** ペーストテキストを単一セル用に正規化する（`|` 除去 / 改行→スペース）。 */
export function sanitizePasteText(raw: string): string {
	return raw.replace(/\|/g, "").replace(/[\r\n]+/g, " ");
}

/** 現在フォーカス中のセルを解決する（activeElement → selection anchor の順）。 */
function getFocusedCell(wrapperEl: HTMLElement): HTMLElement | null {
	const active = document.activeElement;
	if (active instanceof HTMLElement && wrapperEl.contains(active)) {
		const cell = active.closest("th, td");
		if (cell instanceof HTMLElement) return cell;
	}
	const anchor = window.getSelection()?.anchorNode;
	const el = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
	const cell = el?.closest("th, td");
	if (cell instanceof HTMLElement && wrapperEl.contains(cell)) return cell;
	return null;
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

function handleKeydown(e: KeyboardEvent, view: EditorView, wrapperEl: HTMLElement): void {
	// IME コンポジション中はすべてのキー処理をスキップする
	const imeState = getCompositionState(wrapperEl);
	if (e.isComposing || imeState.composing) return;

	// Mod 修飾キーは row/col ガードよりも先に処理する。Chromium は contenteditable 内
	// の keydown.target を子ノード（テキストノード等）にすることがあり、td に向けた
	// dataset.row チェックを掻い潜って素通りし、native の contentEditable undo（cell
	// だけが変わり markdown と desync する）等が走ってしまうのを防ぐ。
	if (e.metaKey || e.ctrlKey) {
		const key = e.key.toLowerCase();
		if (key === "v") return;
		if (key === "c" || key === "x") {
			if (hasMultiCellSelection(wrapperEl)) {
				e.preventDefault();
				e.stopPropagation();
				const text = getSelectedCellsText(wrapperEl);
				if (text) navigator.clipboard?.writeText(text).catch(() => {});
				if (key === "x") clearSelectedCellContents(wrapperEl, view);
				return;
			}
			return;
		}
		if (key === "z") return;
		if (key === "a") {
			e.preventDefault();
			e.stopPropagation();
			if (hasMultiCellSelection(wrapperEl)) {
				const data = getDataFor(wrapperEl);
				if (data) {
					applyCellSelection(wrapperEl, {
						anchor: { row: 0, col: 0 },
						head: { row: data.rows.length - 1, col: colCountOf(data) - 1 },
					});
				}
			} else {
				const cell = (e.target as HTMLElement | null)?.closest?.("th, td") as HTMLElement | null;
				if (cell) {
					const range = document.createRange();
					range.selectNodeContents(cell);
					const sel = window.getSelection();
					sel?.removeAllRanges();
					sel?.addRange(range);
				}
			}
			return;
		}
		e.preventDefault();
		return;
	}

	// マルチセル選択中の操作
	if (hasMultiCellSelection(wrapperEl)) {
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			e.stopPropagation();
			clearSelectedCellContents(wrapperEl, view);
			clearCellSelection(wrapperEl);
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			clearCellSelection(wrapperEl);
			return;
		}
		clearCellSelection(wrapperEl);
	}

	const target = e.target as HTMLElement;
	if (!target.dataset.row || !target.dataset.col) return;

	const data = getDataFor(wrapperEl);
	if (!data) return;

	const rowIdx = Number(target.dataset.row);
	const colIdx = Number(target.dataset.col);
	const { rows } = data;
	const colCount = colCountOf(data);

	if (e.key === "Tab" && !e.shiftKey) {
		e.preventDefault();
		e.stopPropagation();
		let nextRow = rowIdx;
		let nextCol = colIdx + 1;
		if (nextCol >= colCount) {
			nextCol = 0;
			nextRow++;
		}
		if (nextRow >= rows.length) {
			exitTableDown(view, wrapperEl);
			return;
		}
		focusCell(wrapperEl, nextRow, nextCol);
		return;
	}

	if (e.key === "Tab" && e.shiftKey) {
		e.preventDefault();
		e.stopPropagation();
		let prevRow = rowIdx;
		let prevCol = colIdx - 1;
		if (prevCol < 0) {
			prevRow--;
			prevCol = colCount - 1;
		}
		if (prevRow < 0) return;
		focusCell(wrapperEl, prevRow, prevCol);
		return;
	}

	if (e.key === "Enter" && e.shiftKey) {
		e.preventDefault();
		e.stopPropagation();
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const br = document.createElement("br");
			range.insertNode(br);
			// 末尾の <br> はブラウザに折りたたまれるため、
			// ゼロ幅スペースをカーソル用プレースホルダーとして挿入
			const placeholder = document.createTextNode("\u200B");
			br.after(placeholder);
			range.setStart(placeholder, 1);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
			// マークダウンに同期
			handleInput(e, view, wrapperEl);
		}
		return;
	}

	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		e.stopPropagation();
		if (rowIdx + 1 < rows.length) {
			focusCell(wrapperEl, rowIdx + 1, colIdx);
		}
		return;
	}

	if (e.key === "ArrowDown") {
		e.preventDefault();
		e.stopPropagation();
		if (rowIdx + 1 < rows.length) {
			focusCell(wrapperEl, rowIdx + 1, colIdx);
		} else {
			exitTableDown(view, wrapperEl);
		}
		return;
	}

	if (e.key === "ArrowUp") {
		e.preventDefault();
		e.stopPropagation();
		if (rowIdx - 1 >= 0) {
			focusCell(wrapperEl, rowIdx - 1, colIdx);
			return;
		}
		// ドキュメント先頭のテーブルなら、抜ける先が無いのでセル内に留める。
		// （以前は上に空行を補っていたが、意図しないドキュメント改変になるため取りやめ）
		const tableNode = getTableNodeFor(view, wrapperEl);
		if (tableNode && tableNode.startLine === 1) return;
		exitTableUp(view, wrapperEl);
		return;
	}

	if (e.key === "ArrowLeft") {
		// セル内の通常の左移動はネイティブの contentEditable に任せる。
		// 抜ける先（先頭テーブルの左上セルでカーソルがセル先頭）の場合のみ抑止する。
		if (rowIdx === 0 && colIdx === 0) {
			const sel = window.getSelection();
			// 空セル: anchor === td それ自体。非空セル: anchor === td.firstChild（先頭テキストノード）。
			const atCellStart =
				sel?.anchorOffset === 0 &&
				(sel.anchorNode === target || sel.anchorNode === target.firstChild);
			const tableNode = getTableNodeFor(view, wrapperEl);
			if (atCellStart && tableNode && tableNode.startLine === 1) {
				e.preventDefault();
				e.stopPropagation();
				return;
			}
		}
		// それ以外はネイティブに委ねる（stopPropagation せず関数末尾の処理へ）
	}

	if (e.key === "Escape") {
		e.preventDefault();
		exitTableDown(view, wrapperEl);
		return;
	}

	if (e.key === "|") {
		e.preventDefault();
		return;
	}

	e.stopPropagation();
}

function handleFocusOut(wrapperEl: HTMLElement): void {
	compositionState.delete(wrapperEl);
	// フォーカスがテーブル外に完全に移動したらセル選択をクリア。
	// focusout は新しい要素にフォーカスが移る前に発火するため、
	// requestAnimationFrame で実際の移動先を確認する。
	requestAnimationFrame(() => {
		if (!wrapperEl.contains(document.activeElement)) {
			clearCellSelection(wrapperEl);
		}
	});
}

// ── Row operations ───────────────────────────────────

function insertRowAfter(
	view: EditorView,
	wrapperEl: HTMLElement,
	widgetRowIdx: number,
	focusCol: number,
): void {
	const data = getDataFor(wrapperEl);
	if (!data) return;
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const lineOffset = widgetRowIdx === 0 ? 1 : widgetRowToLineOffset(widgetRowIdx);
	const lineNum = tableNode.startLine + lineOffset;
	const docLine = view.state.doc.line(lineNum);

	pendingFocus = {
		tableFrom: widgetPositions.get(wrapperEl) ?? 0,
		row: widgetRowIdx + 1,
		col: focusCol,
	};
	view.dispatch({
		changes: { from: docLine.to, to: docLine.to, insert: `\n${emptyRow(data)}` },
	});
}

function insertRowBefore(
	view: EditorView,
	wrapperEl: HTMLElement,
	widgetRowIdx: number,
	focusCol: number,
): void {
	if (widgetRowIdx === 0) return;
	const data = getDataFor(wrapperEl);
	if (!data) return;
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const lineOffset = widgetRowToLineOffset(widgetRowIdx);
	const lineNum = tableNode.startLine + lineOffset;
	const docLine = view.state.doc.line(lineNum);

	// Focus stays on the original cell (which shifts down by 1)
	pendingFocus = {
		tableFrom: widgetPositions.get(wrapperEl) ?? 0,
		row: widgetRowIdx + 1,
		col: focusCol,
	};
	view.dispatch({
		changes: { from: docLine.from - 1, to: docLine.from - 1, insert: `\n${emptyRow(data)}` },
	});
}

function deleteRowAt(view: EditorView, wrapperEl: HTMLElement, widgetRowIdx: number): void {
	const data = getDataFor(wrapperEl);
	if (!data) return;
	if (data.rows[widgetRowIdx]?.kind === "header") return;
	const dataRows = data.rows.filter((r) => r.kind === "data");
	if (dataRows.length <= 1) return;

	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const lineOffset = widgetRowToLineOffset(widgetRowIdx);
	const lineNum = tableNode.startLine + lineOffset;
	const docLine = view.state.doc.line(lineNum);

	pendingFocus = {
		tableFrom: widgetPositions.get(wrapperEl) ?? 0,
		row: Math.min(widgetRowIdx, data.rows.length - 2),
		col: 0,
	};
	view.dispatch({
		changes: { from: docLine.from - 1, to: docLine.to },
	});
}

// ── Column operations ────────────────────────────────

function insertColumnAt(
	view: EditorView,
	wrapperEl: HTMLElement,
	beforeCol: number,
	focusRow: number,
	focusCol: number,
): void {
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const newLines: string[] = [];
	for (let l = tableNode.startLine; l <= tableNode.endLine; l++) {
		const text = view.state.doc.line(l).text;
		const cells = parseRowCells(text);
		const isDelimiter = delimiterRowRe.test(text);
		cells.splice(beforeCol, 0, isDelimiter ? "---" : "");
		newLines.push(`| ${cells.join(" | ")} |`);
	}

	const from = view.state.doc.line(tableNode.startLine).from;
	const to = view.state.doc.line(tableNode.endLine).to;
	pendingFocus = { tableFrom: widgetPositions.get(wrapperEl) ?? 0, row: focusRow, col: focusCol };
	view.dispatch({ changes: { from, to, insert: newLines.join("\n") } });
}

function deleteColumnAt(
	view: EditorView,
	wrapperEl: HTMLElement,
	col: number,
	focusRow: number,
): void {
	const data = getDataFor(wrapperEl);
	if (!data) return;
	const cc = colCountOf(data);
	if (cc <= 2) return;

	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const newLines: string[] = [];
	for (let l = tableNode.startLine; l <= tableNode.endLine; l++) {
		const text = view.state.doc.line(l).text;
		const cells = parseRowCells(text);
		cells.splice(col, 1);
		newLines.push(`| ${cells.join(" | ")} |`);
	}

	const from = view.state.doc.line(tableNode.startLine).from;
	const to = view.state.doc.line(tableNode.endLine).to;
	pendingFocus = {
		tableFrom: widgetPositions.get(wrapperEl) ?? 0,
		row: focusRow,
		col: Math.min(col, cc - 2),
	};
	view.dispatch({ changes: { from, to, insert: newLines.join("\n") } });
}

// ── Table deletion ───────────────────────────────────

function deleteTable(view: EditorView, wrapperEl: HTMLElement): void {
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const from = view.state.doc.line(tableNode.startLine).from;
	const to = view.state.doc.line(tableNode.endLine).to;
	const deleteTo = to < view.state.doc.length ? to + 1 : to;
	const deleteFrom = from > 0 ? from - 1 : from;

	view.dispatch({
		changes: { from: deleteFrom, to: deleteTo, insert: "" },
		selection: { anchor: Math.min(deleteFrom, view.state.doc.length) },
	});
	view.focus();
}

// ── Context menu ─────────────────────────────────────

/** 前回のコンテキストメニューを閉じてリスナーも解除する */
let activeMenuCleanup: (() => void) | null = null;

function showContextMenu(e: MouseEvent, view: EditorView, wrapperEl: HTMLElement): void {
	// 前回のメニューが残っていればリスナーごと確実に除去
	if (activeMenuCleanup) {
		activeMenuCleanup();
		activeMenuCleanup = null;
	}

	const eventTarget = e.target;
	const baseElement =
		eventTarget instanceof Element
			? eventTarget
			: eventTarget instanceof Node
				? eventTarget.parentElement
				: null;
	if (!baseElement) return;

	const target = baseElement.closest("[data-row][data-col]") as HTMLElement | null;
	if (!target) return;

	e.preventDefault();
	e.stopPropagation();

	const data = getDataFor(wrapperEl);
	if (!data) return;

	const rowIdx = Number(target.dataset.row);
	const colIdx = Number(target.dataset.col);
	const { rows } = data;
	const colCount = colCountOf(data);
	const dataRows = rows.filter((r) => r.kind === "data");
	const isHeader = rows[rowIdx]?.kind === "header";

	type MenuItem = { label: string; action: () => void; disabled?: boolean } | null;
	const items: MenuItem[] = [
		{
			label: "貼り付け",
			action: () => {
				if (!navigator.clipboard) return;
				navigator.clipboard.readText().then(
					(text) => {
						const coord = cellCoordFromElement(target);
						if (coord) applyPasteText(wrapperEl, view, text, coord);
					},
					() => {},
				);
			},
		},
		null,
		{
			label: "上に行を追加",
			action: () => insertRowBefore(view, wrapperEl, rowIdx, colIdx),
			disabled: isHeader,
		},
		{ label: "下に行を追加", action: () => insertRowAfter(view, wrapperEl, rowIdx, colIdx) },
		{
			label: "行を削除",
			action: () => deleteRowAt(view, wrapperEl, rowIdx),
			disabled: isHeader || dataRows.length <= 1,
		},
		null,
		{
			label: "左に列を追加",
			// Focus stays on original column (shifts right)
			action: () => insertColumnAt(view, wrapperEl, colIdx, rowIdx, colIdx + 1),
		},
		{
			label: "右に列を追加",
			// Focus stays on original column
			action: () => insertColumnAt(view, wrapperEl, colIdx + 1, rowIdx, colIdx),
		},
		{
			label: "列を削除",
			action: () => deleteColumnAt(view, wrapperEl, colIdx, rowIdx),
			disabled: colCount <= 2,
		},
		null,
		{ label: "テーブルを削除", action: () => deleteTable(view, wrapperEl) },
	];

	const menu = document.createElement("div");
	menu.className = "cm-table-context-menu";
	Object.assign(menu.style, {
		position: "fixed",
		zIndex: "10000",
		left: `${e.clientX}px`,
		top: `${e.clientY}px`,
		backgroundColor: "var(--color-bg-primary)",
		color: "var(--color-text-primary)",
		border: "1px solid var(--color-border)",
		borderRadius: "6px",
		padding: "4px 0",
		boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
		minWidth: "160px",
		fontSize: "13px",
	});

	const close = () => {
		menu.remove();
		document.removeEventListener("mousedown", onOutside);
		document.removeEventListener("keydown", onEsc);
		activeMenuCleanup = null;
	};
	const onOutside = (ev: MouseEvent) => {
		if (!menu.contains(ev.target as Node)) close();
	};
	const onEsc = (ev: KeyboardEvent) => {
		if (ev.key === "Escape") {
			ev.preventDefault();
			close();
		}
	};
	activeMenuCleanup = close;

	for (const item of items) {
		if (item === null) {
			const sep = document.createElement("div");
			Object.assign(sep.style, {
				height: "1px",
				backgroundColor: "var(--color-border)",
				margin: "4px 0",
			});
			menu.appendChild(sep);
			continue;
		}

		const el = document.createElement("div");
		el.textContent = item.label;
		Object.assign(el.style, {
			padding: "6px 12px",
			cursor: item.disabled ? "default" : "pointer",
			opacity: item.disabled ? "0.4" : "1",
			whiteSpace: "nowrap",
		});

		if (!item.disabled) {
			el.addEventListener("mouseenter", () => {
				el.style.backgroundColor =
					"color-mix(in srgb, var(--color-text-secondary) 10%, transparent)";
			});
			el.addEventListener("mouseleave", () => {
				el.style.backgroundColor = "";
			});
			el.addEventListener("mousedown", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				close();
				item.action();
			});
		}

		menu.appendChild(el);
	}

	document.body.appendChild(menu);

	requestAnimationFrame(() => {
		const rect = menu.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			menu.style.left = `${window.innerWidth - rect.width - 8}px`;
		}
		if (rect.bottom > window.innerHeight) {
			menu.style.top = `${window.innerHeight - rect.height - 8}px`;
		}
	});

	setTimeout(() => {
		document.addEventListener("mousedown", onOutside);
		document.addEventListener("keydown", onEsc);
	});
}

// ── Decoration builder (takes EditorState, not EditorView) ──

export function buildTableDecorations(state: EditorState): DecorationSet {
	const tree = syntaxTree(state);
	const ranges: Range<Decoration>[] = [];

	tree.iterate({
		enter(node) {
			if (node.name !== "Table") return;

			const startLine = state.doc.lineAt(node.from).number;
			const endLine = trimToLastTableLine(state.doc, startLine, state.doc.lineAt(node.to).number);

			const lines: string[] = [];
			for (let l = startLine; l <= endLine; l++) {
				lines.push(state.doc.line(l).text);
			}

			const tableData = parseTableFromLines(lines);
			if (!tableData) return;
			if (tableData.rows.length < 2) return;
			const minCols = Math.min(...tableData.rows.map((r) => r.cells.length));
			if (minCols < 2) return;

			const from = state.doc.line(startLine).from;
			const to = state.doc.line(endLine).to;

			ranges.push(
				Decoration.replace({
					widget: new EditableTableWidget(tableData, from),
					block: true,
				}).range(from, to),
			);

			return false;
		},
	});

	return Decoration.set(ranges, true);
}

// ── StateField (allows block + multi-line replace) ────

const tableDecorationField = StateField.define<DecorationSet>({
	create(state) {
		return buildTableDecorations(state);
	},
	update(decos, tr) {
		for (const effect of tr.effects) {
			if (effect.is(focusTableCellEffect)) {
				pendingFocus = {
					tableFrom: effect.value.tableFrom,
					row: effect.value.row,
					col: effect.value.col,
				};
			}
		}

		if (tr.docChanged || tr.effects.some((e) => e.is(rebuildTableDecos))) {
			return buildTableDecorations(tr.state);
		}
		return decos;
	},
	provide: (f) => EditorView.decorations.from(f),
});

// ── Tree-change detector (triggers rebuild after async parse) ──

const treeChangeDetector = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (!update.docChanged && syntaxTree(update.state) !== syntaxTree(update.startState)) {
				const { view } = update;
				queueMicrotask(() => {
					view.dispatch({ effects: rebuildTableDecos.of(null) });
				});
			}
		}
	},
);

// ── Atomic table ranges + trailing-boundary cursor dodge ──
//
// テーブルは `Decoration.replace({ block: true })` で 1 つの block widget になる。
// selection がこの置換範囲に絡むと CM が widget 高さ分の巨大キャレットを描画し、特に
// テーブル末尾境界（最終行の行末）で顕著になる。これを 2 段で防ぐ:
//
// 1. atomicRanges — テーブルの置換範囲を 1 単位として宣言し、カーソル移動・クリックが
//    範囲内部へ潜り込まないようにする（blockquote / heading と同じ方式）。
// 2. tableCursorFilter — それでも末尾境界（block widget の直後）にカーソルが来ると
//    巨大キャレットが残るため、その位置なら次行先頭へ退避する。境界判定は
//    tableDecorationField（実際に widget 化されているテーブルだけを含む）から行うので、
//    code fence 等に紛れたパイプ行で誤発火しない。docChanged ではデコレーションの末尾を
//    tr.changes で newDoc 座標へマップしてから比較する。

const tableAtomicRanges = EditorView.atomicRanges.of(
	(view) => view.state.field(tableDecorationField, false) ?? Decoration.none,
);

/**
 * 「実際に widget 化されているテーブル」の末尾境界（newDoc 座標）の集合を返す。
 * tr.state は tr 適用後の state を遅延計算し、その過程で tableDecorationField の update も
 * 走るので、newDoc の現実の decoration が得られる。これにより
 *  - この transaction で削除されたテーブルの古い末尾が拾われ続けない（stale 退避防止）
 *  - この transaction で新規に作られたテーブルの末尾も拾える（新規テーブル境界の取りこぼし防止）
 */
function trailingEndsOfTables(tr: Transaction): Set<number> {
	const decos = tr.state.field(tableDecorationField, false);
	const ends = new Set<number>();
	if (!decos) return ends;
	const iter = decos.iter();
	while (iter.value) {
		ends.add(iter.to);
		iter.next();
	}
	return ends;
}

/**
 * テーブル末尾境界に来たカーソルを次行先頭へ退避し、巨大キャレットを防ぐ。テーブルが
 * EOF で終わる（直下に行が無い）場合は改行を 1 つだけ補ってそこへ退避する（テーブル
 * 直下に常に編集可能な行を確保する不変条件。余分な空行は作らない / git 用の末尾改行は
 * 別概念で save 時の processContent が担う）。
 */
const tableCursorFilter = EditorState.transactionFilter.of((tr) => {
	if (!tr.selection) return tr;
	// undo / redo は履歴上の状態を忠実に復元するためのトランザクションなので、ここで
	// カーソルを別位置に動かしたり改行を補ったりしない（さもないと undo 順序が
	// 直感と合わなくなる）。
	const ev = tr.annotation(Transaction.userEvent);
	if (ev === "undo" || ev === "redo") return tr;

	const trailingEnds = trailingEndsOfTables(tr);
	if (trailingEnds.size === 0) return tr;

	const doc = tr.newDoc;
	let appendNewlineAt: number | null = null;
	let modified = false;
	const ranges = tr.selection.ranges.map((range) => {
		if (!range.empty || !trailingEnds.has(range.head)) return range;

		modified = true;
		// 直下に行が無い（テーブルが EOF）なら改行を 1 つ補う。退避先は補った行頭になる。
		if (range.head === doc.length) appendNewlineAt = range.head;
		return EditorSelection.cursor(range.head + 1);
	});

	if (!modified) return tr;
	const selection = EditorSelection.create(ranges, tr.selection.mainIndex);

	// 追加 spec の selection は `sequential: true` で post-merged-changes 座標として扱う。
	// これで docChanged（削除をまたぐ前方退避）でも changes でマップされない。EOF の場合は
	// 直下に改行も 1 つ補う。
	const extra: TransactionSpec = { selection, sequential: true };
	if (appendNewlineAt !== null) {
		extra.changes = { from: appendNewlineAt, insert: "\n" };
	}
	return [tr, extra];
});

// ── Extension ─────────────────────────────────────────

export const tableDecoration: Extension = [
	tableDecorationField,
	treeChangeDetector,
	tableAtomicRanges,
	tableCursorFilter,
];
