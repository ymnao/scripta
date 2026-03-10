import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { getStringWidth } from "../../../lib/east-asian-width";

// ── Types ──────────────────────────────────────────────

export interface CellInfo {
	from: number;
	to: number;
	content: string;
}

export interface TableRowInfo {
	from: number;
	to: number;
	kind: "header" | "delimiter" | "data";
	cells: CellInfo[];
}

export interface TableInfo {
	from: number;
	to: number;
	rows: TableRowInfo[];
}

// ── Parsing ────────────────────────────────────────────

const DELIMITER_RE = /^\s*:?-{1,}:?\s*$/;

function parseRowCells(lineText: string, lineFrom: number): CellInfo[] {
	const cells: CellInfo[] = [];
	let i = 0;
	// Skip leading pipe
	if (lineText[0] === "|") i = 1;

	while (i < lineText.length) {
		const pipeIdx = lineText.indexOf("|", i);
		const segEnd = pipeIdx === -1 ? lineText.length : pipeIdx;
		const raw = lineText.slice(i, segEnd);
		const trimmed = raw.trim();
		const leadingSpaces = raw.length - raw.trimStart().length;

		cells.push({
			from: lineFrom + i + leadingSpaces,
			to: lineFrom + i + leadingSpaces + trimmed.length,
			content: trimmed,
		});

		if (pipeIdx === -1) break;
		i = pipeIdx + 1;
		if (i >= lineText.length) break;
	}
	return cells;
}

function isDelimiterRow(cells: CellInfo[]): boolean {
	return cells.length > 0 && cells.every((c) => DELIMITER_RE.test(c.content));
}

/**
 * Parse a table from the syntax tree at a given position.
 */
export function parseTable(state: EditorState, tableFrom: number, tableTo: number): TableInfo {
	const rows: TableRowInfo[] = [];
	const startLine = state.doc.lineAt(tableFrom).number;
	const endLine = state.doc.lineAt(tableTo).number;
	let headerDone = false;

	for (let l = startLine; l <= endLine; l++) {
		const line = state.doc.line(l);
		const cells = parseRowCells(line.text, line.from);
		const isDelim = !headerDone && isDelimiterRow(cells);
		const kind = isDelim ? "delimiter" : headerDone ? "data" : "header";
		if (isDelim) headerDone = true;
		rows.push({ from: line.from, to: line.to, kind, cells });
	}

	return { from: tableFrom, to: tableTo, rows };
}

/**
 * Find and parse a table at the given cursor position using the syntax tree.
 */
export function findTableAt(state: EditorState, pos: number): TableInfo | null {
	const tree = syntaxTree(state);
	let node = tree.resolve(pos, 1);
	while (node) {
		if (node.name === "Table") {
			return parseTable(state, node.from, node.to);
		}
		if (!node.parent) break;
		node = node.parent;
	}

	// Also try resolving in the other direction
	node = tree.resolve(pos, -1);
	while (node) {
		if (node.name === "Table") {
			return parseTable(state, node.from, node.to);
		}
		if (!node.parent) break;
		node = node.parent;
	}

	return null;
}

// ── Cell navigation ────────────────────────────────────

export interface CellCoord {
	row: number;
	col: number;
	cell: CellInfo;
}

/**
 * Get the cell coordinate at a given document position.
 */
export function getCellAt(table: TableInfo, pos: number): CellCoord | null {
	for (let r = 0; r < table.rows.length; r++) {
		const row = table.rows[r];
		if (pos < row.from || pos > row.to) continue;
		for (let c = 0; c < row.cells.length; c++) {
			const cell = row.cells[c];
			// Allow cursor to be at cell boundaries
			if (c === row.cells.length - 1) {
				if (pos >= cell.from - 2 && pos <= row.to) {
					return { row: r, col: c, cell };
				}
			} else {
				const nextCell = row.cells[c + 1];
				if (pos >= cell.from - 2 && pos < nextCell.from - 2) {
					return { row: r, col: c, cell };
				}
			}
		}
		// Fallback: return first cell of the row
		if (row.cells.length > 0) {
			return { row: r, col: 0, cell: row.cells[0] };
		}
	}
	return null;
}

/**
 * Get the next cell, skipping delimiter rows.
 */
export function getNextCell(table: TableInfo, coord: CellCoord): CellCoord | null {
	let { row, col } = coord;
	col++;
	if (col >= table.rows[row].cells.length) {
		col = 0;
		row++;
	}
	// Skip delimiter rows
	while (row < table.rows.length && table.rows[row].kind === "delimiter") {
		row++;
	}
	if (row >= table.rows.length) return null;
	const cell = table.rows[row].cells[col];
	if (!cell) return null;
	return { row, col, cell };
}

/**
 * Get the previous cell, skipping delimiter rows.
 */
export function getPrevCell(table: TableInfo, coord: CellCoord): CellCoord | null {
	let { row, col } = coord;
	col--;
	if (col < 0) {
		row--;
		// Skip delimiter rows
		while (row >= 0 && table.rows[row].kind === "delimiter") {
			row--;
		}
		if (row < 0) return null;
		col = table.rows[row].cells.length - 1;
	}
	const cell = table.rows[row].cells[col];
	if (!cell) return null;
	return { row, col, cell };
}

// ── Formatting ─────────────────────────────────────────

type Alignment = "left" | "center" | "right";

function parseAlignment(content: string): Alignment {
	const left = content.startsWith(":");
	const right = content.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	return "left";
}

/**
 * Format a table with aligned columns.
 */
export function formatTable(table: TableInfo, state: EditorState): string {
	const { rows } = table;
	if (rows.length === 0) return state.doc.sliceString(table.from, table.to);

	const colCount = Math.max(...rows.map((r) => r.cells.length));

	// Compute column widths (exclude delimiter row)
	const colWidths: number[] = new Array(colCount).fill(3); // minimum 3
	for (const row of rows) {
		if (row.kind === "delimiter") continue;
		for (let c = 0; c < row.cells.length; c++) {
			colWidths[c] = Math.max(colWidths[c], getStringWidth(row.cells[c].content));
		}
	}

	// Parse alignments from delimiter row
	const delimRow = rows.find((r) => r.kind === "delimiter");
	const alignments: Alignment[] = [];
	if (delimRow) {
		for (let c = 0; c < colCount; c++) {
			alignments.push(
				c < delimRow.cells.length ? parseAlignment(delimRow.cells[c].content) : "left",
			);
		}
	}

	// Build formatted lines
	const lines: string[] = [];
	for (const row of rows) {
		if (row.kind === "delimiter") {
			const parts: string[] = [];
			for (let c = 0; c < colCount; c++) {
				const w = colWidths[c];
				const align = c < alignments.length ? alignments[c] : "left";
				if (align === "center") {
					parts.push(`:${"-".repeat(w)}:`);
				} else if (align === "right") {
					parts.push(`${"-".repeat(w)}:`);
				} else {
					parts.push(`:${"-".repeat(w)}`);
				}
			}
			lines.push(`| ${parts.join(" | ")} |`);
		} else {
			const parts: string[] = [];
			for (let c = 0; c < colCount; c++) {
				const content = c < row.cells.length ? row.cells[c].content : "";
				const displayWidth = getStringWidth(content);
				const padding = colWidths[c] - displayWidth;
				parts.push(content + " ".repeat(Math.max(0, padding)));
			}
			lines.push(`| ${parts.join(" | ")} |`);
		}
	}

	return lines.join("\n");
}

// ── Table creation ─────────────────────────────────────

/**
 * Create an empty table template.
 */
export function createEmptyTable(cols: number, rows: number): string {
	const header = `| ${new Array(cols).fill("     ").join(" | ")} |`;
	const delimiter = `| ${new Array(cols).fill("-----").join(" | ")} |`;
	const dataRow = `| ${new Array(cols).fill("     ").join(" | ")} |`;

	const lines = [header, delimiter];
	for (let r = 0; r < rows; r++) {
		lines.push(dataRow);
	}
	return lines.join("\n");
}
