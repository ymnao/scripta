import { syntaxTree } from "@codemirror/language";
import {
	EditorSelection,
	EditorState,
	type Extension,
	type Range,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { getStringWidth } from "../../../lib/east-asian-width";
import { findUnescapedPipe, isLineBlank } from "./table-utils";

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
				return {
					from: node.from,
					to: node.to,
					startLine: state.doc.lineAt(node.from).number,
					endLine: state.doc.lineAt(node.to).number,
				};
			}
			if (!node.parent) break;
			node = node.parent;
		}
	}
	return null;
}

export function focusCell(container: HTMLElement, row: number, col: number): void {
	const cell = container.querySelector(
		`[data-row="${row}"][data-col="${col}"]`,
	) as HTMLElement | null;
	if (cell) {
		cell.focus();
		const range = document.createRange();
		range.selectNodeContents(cell);
		range.collapse(false);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}
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

/** セル表示幅を計算する。`<br>` は改行なので各セグメントの最大幅を返す。 */
function cellDisplayWidth(content: string): number {
	if (!content.includes("<br>")) return getStringWidth(content);
	return Math.max(...content.split("<br>").map(getStringWidth));
}

/** Map widget row index → doc line offset (skip delimiter at doc index 1). */
function widgetRowToLineOffset(widgetRow: number): number {
	return widgetRow >= 1 ? widgetRow + 1 : widgetRow;
}

function formatTableLines(container: HTMLElement, data: TableData): string[] {
	const { rows, alignments } = data;
	const colCount = Math.max(...rows.map((r) => r.cells.length), alignments.length);

	const domRows: string[][] = [];
	for (let r = 0; r < rows.length; r++) {
		const cells: string[] = [];
		for (let c = 0; c < colCount; c++) {
			const cell = container.querySelector(
				`[data-row="${r}"][data-col="${c}"]`,
			) as HTMLElement | null;
			cells.push(cell ? getCellTextContent(cell) : "");
		}
		domRows.push(cells);
	}

	const colWidths: number[] = new Array(colCount).fill(3);
	for (const cellRow of domRows) {
		for (let c = 0; c < cellRow.length; c++) {
			colWidths[c] = Math.max(colWidths[c], cellDisplayWidth(cellRow[c]));
		}
	}

	const lines: string[] = [];
	let domRowIdx = 0;
	for (let i = 0; i <= rows.length; i++) {
		if (i === 1) {
			const parts: string[] = [];
			for (let c = 0; c < colCount; c++) {
				const w = colWidths[c];
				const align = c < alignments.length ? alignments[c] : "left";
				if (align === "center") parts.push(`:${"-".repeat(w - 2)}:`);
				else if (align === "right") parts.push(`${"-".repeat(w - 1)}:`);
				else parts.push("-".repeat(w));
			}
			lines.push(`| ${parts.join(" | ")} |`);
		}
		if (i >= rows.length) break;
		const parts: string[] = [];
		for (let c = 0; c < colCount; c++) {
			const content =
				domRowIdx < domRows.length && c < domRows[domRowIdx].length ? domRows[domRowIdx][c] : "";
			const displayWidth = cellDisplayWidth(content);
			const padding = colWidths[c] - displayWidth;
			parts.push(content + " ".repeat(Math.max(0, padding)));
		}
		lines.push(`| ${parts.join(" | ")} |`);
		domRowIdx++;
	}

	return lines;
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

export function exitTableDown(view: EditorView, wrapperEl: HTMLElement): void {
	(document.activeElement as HTMLElement)?.blur();
	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const { doc } = view.state;
	const endLine = doc.line(tableNode.endLine);

	if (isLineBlank(doc, tableNode.endLine + 1)) {
		// 既にテーブル直下に行がある: その行頭へ移動
		view.dispatch({ selection: { anchor: doc.line(tableNode.endLine + 1).from } });
	} else {
		// 直下に行が無い（EOF / 直下が本文）: 改行を 1 つ補って行を作りその行頭へ
		view.dispatch({
			changes: { from: endLine.to, insert: "\n" },
			selection: { anchor: endLine.to + 1 },
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

		const structuralChange = pendingFocus !== null && pendingFocus.tableFrom === this.tableFrom;

		const focused = dom.querySelector(":focus") as HTMLElement | null;
		const focusedRow = focused?.dataset.row;
		const focusedCol = focused?.dataset.col;

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
				if (!structuralChange && focusedRow === String(r) && focusedCol === String(c)) continue;
				const content = c < row.cells.length ? row.cells[c].content : "";
				if (getCellTextContent(cell) !== content) {
					setCellContent(cell, content);
				}
			}
		}

		if (pendingFocus && pendingFocus.tableFrom === this.tableFrom) {
			const focus = pendingFocus;
			pendingFocus = null;
			requestAnimationFrame(() => focusCell(dom, focus.row, focus.col));
		}

		return true;
	}

	ignoreEvent(e: Event): boolean {
		if (e instanceof KeyboardEvent && (e.metaKey || e.ctrlKey)) {
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
		wrapper.addEventListener("focusout", (e) => handleFocusOut(e as FocusEvent, view, wrapper));
		wrapper.addEventListener("contextmenu", (e) => showContextMenu(e as MouseEvent, view, wrapper));
		wrapper.addEventListener("paste", (e) => {
			e.preventDefault();
			const sanitized = sanitizePasteText(e.clipboardData?.getData("text/plain") ?? "");
			if (!sanitized) return;
			// フォーカスセルを正規化してから挿入する（e.target が text node /
			// wrapper のケースで挿入先がずれて反映されないのを防ぐ）
			const cell = getFocusedCell(wrapper);
			if (!cell) return;
			pasteIntoCell(cell, sanitized, view, wrapper);
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

/** セルの属する行を DOM から読み取り、対応するドキュメント行へ反映する。 */
function syncRowFromCell(cell: HTMLElement, view: EditorView, wrapperEl: HTMLElement): void {
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
	});
}

function handleInput(e: Event, view: EditorView, wrapperEl: HTMLElement): void {
	const target = e.target as HTMLElement;
	// input target が text node / <br> の場合もあるためセルへ正規化する
	const cell = target.closest?.("th, td") as HTMLElement | null;
	if (!cell) return;
	syncRowFromCell(cell, view, wrapperEl);
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
		} else {
			exitTableUp(view, wrapperEl);
		}
		return;
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

	// Mod+key はエディタのショートカット (Mod-s, Mod-b 等) に委譲する
	// contentEditable のリッチテキストコマンド（太字・斜体等）を抑止しつつ、
	// stopPropagation しないことで CM6 のキーマップに処理を委譲する
	if (e.metaKey || e.ctrlKey) {
		e.preventDefault();
		return;
	}

	e.stopPropagation();
}

function handleFocusOut(e: FocusEvent, view: EditorView, wrapperEl: HTMLElement): void {
	const related = e.relatedTarget as HTMLElement | null;
	if (related && wrapperEl.contains(related)) return;

	// フォーカスがテーブル外に移動したら IME フラグをリセット
	compositionState.delete(wrapperEl);

	const tableNode = getTableNodeFor(view, wrapperEl);
	if (!tableNode) return;

	const lines: string[] = [];
	for (let l = tableNode.startLine; l <= tableNode.endLine; l++) {
		lines.push(view.state.doc.line(l).text);
	}
	const currentData = parseTableFromLines(lines);
	if (!currentData) return;

	const formatted = formatTableLines(wrapperEl, currentData);
	if (formatted.join("\n") === lines.join("\n")) return;

	const from = view.state.doc.line(tableNode.startLine).from;
	const to = view.state.doc.line(tableNode.endLine).to;
	view.dispatch({
		changes: { from, to, insert: formatted.join("\n") },
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
						const sanitized = sanitizePasteText(text);
						if (sanitized) pasteIntoCell(target, sanitized, view, wrapperEl);
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
			let endLine = state.doc.lineAt(node.to).number;

			// Trim trailing non-table lines (parser may include adjacent text)
			while (endLine > startLine) {
				const text = state.doc.line(endLine).text.trim();
				if (text.includes("|")) break;
				endLine--;
			}

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

// ── Cursor clamp (avoid the full-height caret at the table's end) ──

/**
 * pos が block table の末尾境界（最終行の行末）かを判定する。該当すれば true。
 * 安価な事前フィルタ（行末かつ `|` を含む行）を先に通し、syntaxTree を引く
 * findTableNode はそこを通過した時だけ呼ぶ（カーソル移動ごとに走る hot path のため）。
 */
function isTableEndBoundary(state: EditorState, pos: number): boolean {
	const line = state.doc.lineAt(pos);
	if (pos !== line.to || !line.text.includes("|")) return false;
	const tableNode = findTableNode(state, pos);
	if (!tableNode) return false;
	// 問題になるのはテーブル末尾境界のみ（上端境界はテーブル直前の正当な位置）
	return pos === state.doc.line(tableNode.endLine).to;
}

/**
 * テーブルは `Decoration.replace({ block: true })` で 1 つの block widget に
 * なるため、selection head がテーブル末尾境界（最終行の行末）に来ると widget
 * 高さ分の巨大キャレットが描画される。head がその位置に来たら次行先頭へ退避する。
 *
 * insertTable / exitTableDown はテーブル直下に行を確保するが、手入力・インポート
 * 済みの既存ファイルではテーブルが EOF で終わる（直下に行が無い）こともある。その
 * 場合は改行を 1 つだけ補って行を作り、そこへ退避する（テーブル直下に常に編集可能な
 * 行を確保する不変条件。余分な空行は作らない / git 用の末尾改行は別概念で save 時の
 * processContent が担う）。補った change により後続トランザクションは docChanged
 * となり、本フィルタの先頭ガードで再入しない。
 *
 * 本フィルタは selection 変更のみのトランザクション（ナビゲーション）を扱う。
 * transactionFilter は新 state の syntaxTree を参照できず、doc 変更後は位置も
 * ずれるため、削除 / undo で境界に残るケースは tableBoundaryGuard が補正する。
 */
const tableCursorFilter = EditorState.transactionFilter.of((tr) => {
	if (!tr.selection || tr.docChanged) return tr;

	const doc = tr.newDoc;
	let modified = false;
	let appendNewlineAt: number | null = null;
	const ranges = tr.selection.ranges.map((range) => {
		// docChanged でないので tr.startState の位置と head は一致する
		if (!range.empty || !isTableEndBoundary(tr.startState, range.head)) return range;

		modified = true;
		// 直下に行が無い（テーブルが EOF）なら改行を 1 つ補う。退避先は補った行頭になる。
		if (range.head === doc.length) appendNewlineAt = range.head;
		return EditorSelection.cursor(range.head + 1);
	});

	if (!modified) return tr;
	const selection = EditorSelection.create(ranges, tr.selection.mainIndex);
	if (appendNewlineAt !== null) {
		return [tr, { changes: { from: appendNewlineAt, insert: "\n" }, selection }];
	}
	return [tr, { selection }];
});

/**
 * 削除 / undo など doc 変更後にカーソルがテーブル末尾境界へ取り残されるケースを補正する。
 * transactionFilter（tableCursorFilter）は新 state の syntaxTree を参照できないため
 * doc 変更トランザクションを扱えない。本 ViewPlugin は state 構築後の update() で
 * syntaxTree(view.state) を使って判定し、必要なら次行先頭へ退避（EOF なら改行を補完）する。
 *
 * - エディタにフォーカスがある（= ユーザーがエディタ本体を操作中）ときのみ動作する。
 *   セル編集中は contentEditable 側にフォーカスがあり view.hasFocus は false なので、
 *   セル入力（syncRowFromCell の dispatch）には介入しない。
 * - dispatch は update() 内で同期に呼べないため queueMicrotask で次 tick に回す
 *   （描画前に走るので巨大キャレットは paint されない）。
 */
const tableBoundaryGuard = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (!update.docChanged || !update.view.hasFocus) return;
			const sel = update.state.selection.main;
			if (!sel.empty || !isTableEndBoundary(update.state, sel.head)) return;

			const { view } = update;
			const head = sel.head;
			queueMicrotask(() => {
				const s = view.state.selection.main;
				// 状況が変わっていない（まだ境界に居る）ことを確認してから補正
				if (!s.empty || s.head !== head || !isTableEndBoundary(view.state, head)) return;
				const atEof = head === view.state.doc.length;
				view.dispatch({
					changes: atEof ? { from: head, insert: "\n" } : undefined,
					selection: { anchor: head + 1 },
				});
			});
		}
	},
);

// ── Extension ─────────────────────────────────────────

export const tableDecoration: Extension = [
	tableDecorationField,
	treeChangeDetector,
	tableCursorFilter,
	tableBoundaryGuard,
];
