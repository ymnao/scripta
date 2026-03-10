import { syntaxTree } from "@codemirror/language";
import {
	type EditorState,
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

// ── Effects ───────────────────────────────────────────

export const focusTableCellEffect = StateEffect.define<{
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
		const pipeIdx = text.indexOf("|", i);
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

function focusCell(container: HTMLElement, row: number, col: number): void {
	const cell = container.querySelector(
		`[data-row="${row}"][data-col="${col}"]`,
	) as HTMLElement | null;
	if (cell) {
		cell.focus();
		const range = document.createRange();
		range.selectNodeContents(cell);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}
}

function applyCellStyle(el: HTMLElement, isHeader: boolean): void {
	el.style.border = "1px solid var(--color-border)";
	el.style.padding = "4px 8px";
	el.style.minWidth = "3em";
	el.style.outline = "none";
	if (isHeader) el.style.fontWeight = "700";
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
			cells.push(cell?.textContent || "");
		}
		domRows.push(cells);
	}

	const colWidths: number[] = new Array(colCount).fill(3);
	for (const cellRow of domRows) {
		for (let c = 0; c < cellRow.length; c++) {
			colWidths[c] = Math.max(colWidths[c], getStringWidth(cellRow[c]));
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
				if (align === "center") parts.push(`:${"-".repeat(w)}:`);
				else if (align === "right") parts.push(`${"-".repeat(w)}:`);
				else parts.push(`:${"-".repeat(w)}`);
			}
			lines.push(`| ${parts.join(" | ")} |`);
		}
		if (i >= rows.length) break;
		const parts: string[] = [];
		for (let c = 0; c < colCount; c++) {
			const content =
				domRowIdx < domRows.length && c < domRows[domRowIdx].length ? domRows[domRowIdx][c] : "";
			const displayWidth = getStringWidth(content);
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
let pendingFocus: { row: number; col: number } | null = null;

class EditableTableWidget extends WidgetType {
	constructor(
		readonly data: TableData,
		readonly tableFrom: number,
	) {
		super();
	}

	eq(other: EditableTableWidget): boolean {
		if (this.tableFrom !== other.tableFrom) return false;
		const a = this.data.rows;
		const b = other.data.rows;
		if (a.length !== b.length) return false;
		for (let r = 0; r < a.length; r++) {
			if (a[r].cells.length !== b[r].cells.length) return false;
			for (let c = 0; c < a[r].cells.length; c++) {
				if (a[r].cells[c].content !== b[r].cells[c].content) return false;
			}
		}
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const wrapper = this.buildDOM(view);
		widgetPositions.set(wrapper, this.tableFrom);

		if (pendingFocus) {
			const focus = pendingFocus;
			pendingFocus = null;
			requestAnimationFrame(() => focusCell(wrapper, focus.row, focus.col));
		}

		return wrapper;
	}

	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		widgetPositions.set(dom, this.tableFrom);

		const tableEl = dom.querySelector("table");
		if (!tableEl) return false;

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
				applyCellStyle(cell, isHeader);
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
				applyCellStyle(cell, isHeader);
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
				if (focusedRow === String(r) && focusedCol === String(c)) continue;
				const content = c < row.cells.length ? row.cells[c].content : "";
				if (cell.textContent !== content) {
					cell.textContent = content;
				}
			}
		}

		if (pendingFocus) {
			const focus = pendingFocus;
			pendingFocus = null;
			requestAnimationFrame(() => focusCell(dom, focus.row, focus.col));
		}

		return true;
	}

	ignoreEvent(): boolean {
		return true;
	}

	private buildDOM(view: EditorView): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = "cm-table-widget";
		wrapper.contentEditable = "false";
		wrapper.style.margin = "4px 0";

		const table = document.createElement("table");
		table.style.borderCollapse = "collapse";

		const { rows, alignments } = this.data;
		const colCount = Math.max(...rows.map((r) => r.cells.length), alignments.length);

		for (let r = 0; r < rows.length; r++) {
			const rowData = rows[r];
			const tr = document.createElement("tr");
			const isHeader = rowData.kind === "header";

			for (let c = 0; c < colCount; c++) {
				const cell = document.createElement(isHeader ? "th" : "td");
				cell.className = "cm-table-cell";
				cell.textContent = c < rowData.cells.length ? rowData.cells[c].content : "";
				cell.contentEditable = "true";
				cell.dataset.row = String(r);
				cell.dataset.col = String(c);
				applyCellStyle(cell, isHeader);
				if (c < alignments.length) cell.style.textAlign = alignments[c];
				tr.appendChild(cell);
			}
			table.appendChild(tr);
		}

		wrapper.appendChild(table);

		wrapper.addEventListener("input", (e) => this.handleInput(e, view, wrapper));
		wrapper.addEventListener("keydown", (e) => this.handleKeydown(e, view, wrapper));
		wrapper.addEventListener("focusout", (e) =>
			this.handleFocusOut(e as FocusEvent, view, wrapper),
		);

		return wrapper;
	}

	private handleInput(e: Event, view: EditorView, wrapperEl: HTMLElement): void {
		const target = e.target as HTMLElement;
		const rowIdx = Number(target.dataset.row);
		if (Number.isNaN(rowIdx)) return;

		const pos = widgetPositions.get(wrapperEl);
		if (pos === undefined) return;

		const tableNode = findTableNode(view.state, pos);
		if (!tableNode) return;

		const lineOffset = widgetRowToLineOffset(rowIdx);
		const lineNum = tableNode.startLine + lineOffset;
		if (lineNum > view.state.doc.lines) return;

		const docLine = view.state.doc.line(lineNum);
		const tr = target.closest("tr");
		if (!tr) return;

		const cellContents: string[] = [];
		for (const td of tr.querySelectorAll("th, td")) {
			cellContents.push(td.textContent || "");
		}

		const newLine = `| ${cellContents.join(" | ")} |`;
		if (newLine === view.state.doc.sliceString(docLine.from, docLine.to)) return;

		view.dispatch({
			changes: { from: docLine.from, to: docLine.to, insert: newLine },
		});
	}

	private handleKeydown(e: KeyboardEvent, view: EditorView, wrapperEl: HTMLElement): void {
		const target = e.target as HTMLElement;
		if (!target.dataset.row || !target.dataset.col) return;

		const rowIdx = Number(target.dataset.row);
		const colIdx = Number(target.dataset.col);
		const { rows, alignments } = this.data;
		const colCount = Math.max(...rows.map((r) => r.cells.length), alignments.length);

		if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z" || e.key === "y")) {
			(document.activeElement as HTMLElement)?.blur();
			view.focus();
			return;
		}

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
				this.addRowAtEnd(view, wrapperEl, rows.length, 0);
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

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			this.insertRowAfter(view, wrapperEl, rowIdx, 0);
			return;
		}

		if (e.key === "Backspace" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			e.stopPropagation();
			this.deleteRowAt(view, wrapperEl, rowIdx);
			return;
		}

		if (e.key === "Escape") {
			e.preventDefault();
			(document.activeElement as HTMLElement)?.blur();
			const pos = widgetPositions.get(wrapperEl);
			if (pos !== undefined) {
				const tableNode = findTableNode(view.state, pos);
				if (tableNode) {
					const after = Math.min(tableNode.to + 1, view.state.doc.length);
					view.dispatch({ selection: { anchor: after } });
					view.focus();
				}
			}
			return;
		}

		if (e.key === "|") {
			e.preventDefault();
			return;
		}

		e.stopPropagation();
	}

	private handleFocusOut(e: FocusEvent, view: EditorView, wrapperEl: HTMLElement): void {
		const related = e.relatedTarget as HTMLElement | null;
		if (related && wrapperEl.contains(related)) return;

		const pos = widgetPositions.get(wrapperEl);
		if (pos === undefined) return;

		const tableNode = findTableNode(view.state, pos);
		if (!tableNode) return;

		const formatted = formatTableLines(wrapperEl, this.data);
		const original: string[] = [];
		for (let l = tableNode.startLine; l <= tableNode.endLine; l++) {
			original.push(view.state.doc.line(l).text);
		}

		if (formatted.join("\n") === original.join("\n")) return;

		const from = view.state.doc.line(tableNode.startLine).from;
		const to = view.state.doc.line(tableNode.endLine).to;
		view.dispatch({
			changes: { from, to, insert: formatted.join("\n") },
		});
	}

	private addRowAtEnd(
		view: EditorView,
		wrapperEl: HTMLElement,
		focusRow: number,
		focusCol: number,
	): void {
		const pos = widgetPositions.get(wrapperEl);
		if (pos === undefined) return;
		const tableNode = findTableNode(view.state, pos);
		if (!tableNode) return;

		const lastLine = view.state.doc.line(tableNode.endLine);
		const colCount = Math.max(
			...this.data.rows.map((r) => r.cells.length),
			this.data.alignments.length,
		);
		const newRow = `| ${new Array(colCount).fill("  ").join(" | ")} |`;

		pendingFocus = { row: focusRow, col: focusCol };
		view.dispatch({
			changes: {
				from: lastLine.to,
				to: lastLine.to,
				insert: `\n${newRow}`,
			},
		});
	}

	private insertRowAfter(
		view: EditorView,
		wrapperEl: HTMLElement,
		widgetRowIdx: number,
		focusCol: number,
	): void {
		const pos = widgetPositions.get(wrapperEl);
		if (pos === undefined) return;
		const tableNode = findTableNode(view.state, pos);
		if (!tableNode) return;

		const lineOffset = widgetRowToLineOffset(widgetRowIdx);
		const lineNum = tableNode.startLine + lineOffset;
		const docLine = view.state.doc.line(lineNum);
		const colCount = Math.max(
			...this.data.rows.map((r) => r.cells.length),
			this.data.alignments.length,
		);
		const newRow = `| ${new Array(colCount).fill("  ").join(" | ")} |`;

		pendingFocus = { row: widgetRowIdx + 1, col: focusCol };
		view.dispatch({
			changes: {
				from: docLine.to,
				to: docLine.to,
				insert: `\n${newRow}`,
			},
		});
	}

	private deleteRowAt(view: EditorView, wrapperEl: HTMLElement, widgetRowIdx: number): void {
		if (this.data.rows[widgetRowIdx].kind === "header") return;
		const dataRows = this.data.rows.filter((r) => r.kind === "data");
		if (dataRows.length <= 1) return;

		const pos = widgetPositions.get(wrapperEl);
		if (pos === undefined) return;
		const tableNode = findTableNode(view.state, pos);
		if (!tableNode) return;

		const lineOffset = widgetRowToLineOffset(widgetRowIdx);
		const lineNum = tableNode.startLine + lineOffset;
		const docLine = view.state.doc.line(lineNum);

		pendingFocus = {
			row: Math.min(widgetRowIdx, this.data.rows.length - 2),
			col: 0,
		};
		view.dispatch({
			changes: { from: docLine.from - 1, to: docLine.to },
		});
	}
}

// ── Decoration builder (takes EditorState, not EditorView) ──

export function buildTableDecorations(state: EditorState): DecorationSet {
	const tree = syntaxTree(state);
	const ranges: Range<Decoration>[] = [];

	tree.iterate({
		enter(node) {
			if (node.name !== "Table") return;

			const startLine = state.doc.lineAt(node.from).number;
			const endLine = state.doc.lineAt(node.to).number;

			const lines: string[] = [];
			for (let l = startLine; l <= endLine; l++) {
				lines.push(state.doc.line(l).text);
			}

			const tableData = parseTableFromLines(lines);
			if (!tableData) return;
			if (tableData.rows.length < 2) return;
			const minCols = Math.min(...tableData.rows.map((r) => r.cells.length));
			if (minCols < 2) return;

			ranges.push(
				Decoration.replace({
					widget: new EditableTableWidget(tableData, node.from),
					block: true,
				}).range(node.from, node.to),
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
				pendingFocus = effect.value;
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

// ── Extension ─────────────────────────────────────────

export const tableDecoration: Extension = [tableDecorationField, treeChangeDetector];
