import { syntaxTree } from "@codemirror/language";
import {
	Annotation,
	ChangeSet,
	EditorSelection,
	EditorState,
	type Extension,
	type Range,
	StateEffect,
	StateField,
	Transaction,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	layer,
	RectangleMarker,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { cmdOrCtrl } from "../../../lib/keyboard";
import {
	type BlockFieldValue,
	blockFieldNeedsRebuild,
	type CandidateRange,
	mapCandidates,
	treeChangeDispatcher,
	treeParseProgressed,
} from "./plugin-utils";
import { trimToLastTableLine } from "./table-utils";
import {
	applyCellSelection,
	applyPasteText,
	cellCoordFromElement,
	cellSelectionMap,
	clearCellSelection,
	clearSelectedCellContents,
	colCountOf,
	delimiterRowRe,
	emptyRow,
	exitTableDown,
	exitTableUp,
	focusCell,
	getCellTextContent,
	getDataFor,
	getSelectedCellsText,
	getTableNodeFor,
	handleCellMouseDown,
	hasMultiCellSelection,
	parseRowCells,
	parseTableFromLines,
	placeCaretAtEnd,
	setCellContent,
	setCellFocusEffect,
	syncRowFromCell,
	type TableData,
	tableCellFocusField,
	widgetDataMap,
	widgetPositions,
	widgetRowToLineOffset,
} from "./table-widget-core";

export {
	clearCellSelection,
	exitTableDown,
	focusCell,
	parseTsv,
	pasteIntoCell,
	placeCaretAtEnd,
	sanitizePasteText,
	tableCellFocusField,
} from "./table-widget-core";

// ── Effects ───────────────────────────────────────────

export const focusTableCellEffect = StateEffect.define<{
	tableFrom: number;
	row: number;
	col: number;
}>();

// ── Widget ────────────────────────────────────────────

let pendingFocus: { tableFrom: number; row: number; col: number } | null = null;

/** IME 状態追跡（ウィジェット単位）。compositionActive はコンポジション中に true。
 *  composing は compositionstart で true になり、compositionend 後の
 *  最初の keyup で false になる。これにより確定 Enter の keydown を
 *  確実にスキップできる。 */
const compositionState = new WeakMap<HTMLElement, { active: boolean; composing: boolean }>();

function getCompositionState(el: HTMLElement) {
	return compositionState.get(el) ?? { active: false, composing: false };
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
		if (e instanceof KeyboardEvent && cmdOrCtrl(e)) {
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
		// セル外（padding 帯・テーブル右余白）のクリックはエディタに委譲し、カーソル配置を
		// 可能にする。クリックはテーブル境界 position に解決されるが、tableCursorFilter が
		// 隣接行へ退避するので巨大キャレットにはならない (#146)。
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
		// セルへ実フォーカスが入ったら field を true にし、gap 描画を抑制する（#167）。
		// 既に true なら dispatch しない（重複 dispatch 回避）。
		wrapper.addEventListener("focusin", (e) => {
			const cell = (e.target as Element | null)?.closest?.("th, td");
			if (!cell) return;
			if (!view.state.field(tableCellFocusField, false)) {
				view.dispatch({ effects: setCellFocusEffect.of(true) });
			}
		});
		wrapper.addEventListener("focusout", () => handleFocusOut(view, wrapper));
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

function handleInput(e: Event, view: EditorView, wrapperEl: HTMLElement): void {
	const target = e.target as HTMLElement;
	// input target が text node / <br> の場合もあるためセルへ正規化する
	const cell = target.closest?.("th, td") as HTMLElement | null;
	if (!cell) return;
	syncRowFromCell(cell, view, wrapperEl, /* fromTyping= */ true);
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

function handleKeydown(e: KeyboardEvent, view: EditorView, wrapperEl: HTMLElement): void {
	// IME コンポジション中はすべてのキー処理をスキップする
	const imeState = getCompositionState(wrapperEl);
	if (e.isComposing || imeState.composing) return;

	// Mod 修飾キーは row/col ガードよりも先に処理する。Chromium は contenteditable 内
	// の keydown.target を子ノード（テキストノード等）にすることがあり、td に向けた
	// dataset.row チェックを掻い潜って素通りし、native の contentEditable undo（cell
	// だけが変わり markdown と desync する）等が走ってしまうのを防ぐ。
	if (cmdOrCtrl(e)) {
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
		// 最上行からは前行末尾へ抜ける。ドキュメント先頭のテーブルでは抜ける先の行が
		// 無いが、BOF gap（#167）に文書を変えずに留まれるのでそのまま抜けてよい。
		exitTableUp(view, wrapperEl);
		return;
	}

	if (e.key === "ArrowLeft") {
		// セル内の通常の左移動はネイティブの contentEditable に任せる。
		// 先頭テーブルの左上セルでカーソルがセル先頭の場合のみ、BOF gap へ明示的に
		// 抜ける（native に任せると widget の外の DOM へ予測しづらい移動をするため）。
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
				exitTableUp(view, wrapperEl);
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

function handleFocusOut(view: EditorView, wrapperEl: HTMLElement): void {
	compositionState.delete(wrapperEl);
	// フォーカスがテーブル外に完全に移動したらセル選択をクリアし、セルフォーカス field を
	// 下ろして gap 描画の抑制を解く（#167）。focusout は新しい要素にフォーカスが移る前に
	// 発火するため、requestAnimationFrame で実際の移動先を確認する。
	requestAnimationFrame(() => {
		if (wrapperEl.contains(document.activeElement)) return;
		clearCellSelection(wrapperEl);
		// rAF 時点で view が destroy されている可能性がある（dispatch すると例外）。
		// dom が DOM ツリーから外れていたら触らない。
		if (!view.dom.isConnected) return;
		if (view.state.field(tableCellFocusField, false)) {
			view.dispatch({ effects: setCellFocusEffect.of(false) });
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

/** buildTableDecorations の内部実装。decoration set に加えて、StateField の差分
 *  再構築判定 (blockFieldNeedsRebuild) が使う candidate 範囲 (`Table` node として
 *  検出した全範囲) を返す。widget 化が rejected されたマッチ (parseTableFromLines
 *  失敗 / rows < 2 / minCols < 2) も candidate に含める — それらが隣接編集で
 *  non-table ⇔ table に切り替わりうる以上、bail-early は安全側 (false = full
 *  rebuild) に倒すべきため (math.ts の buildMathDecorationsAndCandidates と同型)。 */
function buildTableDecorationsAndCandidates(state: EditorState): BlockFieldValue {
	const tree = syntaxTree(state);
	const ranges: Range<Decoration>[] = [];
	const candidates: CandidateRange[] = [];

	tree.iterate({
		enter(node) {
			if (node.name !== "Table") return;

			const startLine = state.doc.lineAt(node.from).number;
			const endLine = trimToLastTableLine(state.doc, startLine, state.doc.lineAt(node.to).number);

			const from = state.doc.line(startLine).from;
			const to = state.doc.line(endLine).to;
			candidates.push({ from, to });

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
					widget: new EditableTableWidget(tableData, from),
					block: true,
				}).range(from, to),
			);

			return false;
		},
	});

	return { decos: Decoration.set(ranges, true), candidates };
}

/** 公開 API: DecorationSet のみを返す (既存の呼び出し元 / テスト向けの後方互換ラッパー)。 */
export function buildTableDecorations(state: EditorState): DecorationSet {
	return buildTableDecorationsAndCandidates(state).decos;
}

/** table candidate 判定の marker 文字。挿入/削除テキストに `|` が含まれれば
 *  新規候補の出現/消滅の可能性があるため full rebuild にフォールバックする。 */
// non-global にすることで `.test()` が stateless になり、呼び出しをまたいだ
// lastIndex 状態漏れ (false negative = rebuild 漏れ) が構造的に発生しなくなる。
const TABLE_MARKER_RE = /\|/;

// ── StateField (allows block + multi-line replace) ────

export const tableDecorationField = StateField.define<BlockFieldValue>({
	create(state) {
		return buildTableDecorationsAndCandidates(state);
	},
	update(value, tr) {
		// focusTableCellEffect の副作用 (pendingFocus 更新) と treeParseProgressed 判定は
		// 1 pass で処理する。rebuild 効果があっても pendingFocus 側の副作用は落とさない
		// ため、return は effects を全て走査してから行う。
		let needsRebuild = false;
		for (const effect of tr.effects) {
			if (effect.is(focusTableCellEffect)) {
				pendingFocus = {
					tableFrom: effect.value.tableFrom,
					row: effect.value.row,
					col: effect.value.col,
				};
			} else if (effect.is(treeParseProgressed)) {
				needsRebuild = true;
			}
		}
		if (needsRebuild) return buildTableDecorationsAndCandidates(tr.state);

		if (tr.docChanged) {
			if (blockFieldNeedsRebuild(tr, value.candidates, TABLE_MARKER_RE)) {
				return buildTableDecorationsAndCandidates(tr.state);
			}
			return {
				decos: value.decos.map(tr.changes),
				candidates: mapCandidates(value.candidates, tr.changes),
			};
		}

		// table はカーソル出入りで見た目が変わらない (math と違い hasFocus に連動しない)
		// ため、selection 変化での rebuild は不要。math のような cursorTouchesCandidates
		// 分岐はここでは入れない。
		return value;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

// ── widgetPositions / dataset.tableFrom の位置同期 (#303 Phase 2) ──
//
// Phase 2 の差分再構築で `blockFieldNeedsRebuild` が false を返すと、field は
// `value.decos.map(tr.changes)` で widget インスタンスをそのまま再利用する。この
// 経路では CodeMirror が widget の toDOM/updateDOM を呼ばないため、そこで
// widgetPositions.set / dataset.tableFrom = String(this.tableFrom) を実行している
// リフレッシュが行われず、テーブルより前を編集して doc 座標が shift したときに
// widgetPositions と dataset.tableFrom がテーブルの旧オフセットのまま残る。
//
// この結果、`getTableNodeFor` (widgetPositions ベース) や `findWidgetForTable`
// (dataset.tableFrom ベース) が旧オフセットを新 tree に投影して Table node を取り
// 損ね、toolbar 操作 / 矢印キー遷移 / pendingFocus マッチが silent に失敗する。
// Phase 1 以前は docChanged で常に full rebuild → toDOM/updateDOM が走っていたため
// この invariant は暗黙に保たれていた。
//
// ここでは docChanged 毎に `posAtDOM` で widget wrapper の現在位置を引き直し、両
// キャッシュを live 位置へ矯正する。full rebuild 経路でも直後の toDOM/updateDOM
// が同じ値を再設定するので副作用はない。
//
// ViewPlugin.update は DOM commit の**前**に走るため、この時点で view.posAtDOM が
// 返すのは旧 DOM の doc 座標。DOM commit 後に posAtDOM を再評価する必要があるので
// queueMicrotask 経由で defer する (treeChangeDetector が rebuild dispatch を defer
// するのと同じ理由)。
const tableWidgetPositionSync = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (!update.docChanged) return;
			const { view } = update;
			queueMicrotask(() => {
				for (const el of view.dom.querySelectorAll<HTMLElement>(".cm-table-widget")) {
					const pos = view.posAtDOM(el);
					widgetPositions.set(el, pos);
					el.dataset.tableFrom = String(pos);
				}
			});
		}
	},
);

// ── Atomic table ranges + boundary cursor handling ──
//
// テーブルは `Decoration.replace({ block: true })` で 1 つの block widget になる。
// selection がこの置換範囲に絡むと CM (drawSelection) が widget 高さ分の巨大キャレットを
// 描画するため、境界へのカーソルを 3 段で扱う:
//
// 1. atomicRanges — テーブルの置換範囲を 1 単位として宣言し、カーソル移動・クリックが
//    範囲内部へ潜り込まないようにする（blockquote / heading と同じ方式）。
// 2. tableCursorFilter — 文書中間のテーブル境界（前後に通常の行がある）に来たカーソルは
//    隣接行へ退避する。境界判定は tableDecorationField（実際に widget 化されている
//    テーブルだけを含む）から行うので、code fence 等に紛れたパイプ行で誤発火しない。
// 3. gap cursor (#167) — 文書先頭/末尾がテーブルの場合は退避先の行が存在しない。この
//    位置は「gap」として文書を一切変えずにカーソルが留まれるようにする（ProseMirror の
//    gapcursor 相当）。描画は tableGapCursorLayer が、入力時の改行補填（materialize）は
//    tableGapMaterialize（typing / paste）と tableGapImeKeydown（IME）が担う。

const tableAtomicRanges = EditorView.atomicRanges.of(
	(view) => view.state.field(tableDecorationField, false)?.decos ?? Decoration.none,
);

/**
 * 「実際に widget 化されているテーブル」の先頭・末尾境界（newDoc 座標）を返す。
 * tr.state は tr 適用後の state を遅延計算し、その過程で tableDecorationField の update も
 * 走るので、newDoc の現実の decoration が得られる。これにより
 *  - この transaction で削除されたテーブルの古い境界が拾われ続けない（stale 退避防止）
 *  - この transaction で新規に作られたテーブルの境界も拾える（取りこぼし防止）
 */
function tableBoundaries(tr: Transaction): { starts: Set<number>; ends: Set<number> } {
	const decos = tr.state.field(tableDecorationField, false)?.decos;
	const starts = new Set<number>();
	const ends = new Set<number>();
	if (!decos) return { starts, ends };
	const iter = decos.iter();
	while (iter.value) {
		starts.add(iter.from);
		ends.add(iter.to);
		iter.next();
	}
	return { starts, ends };
}

/**
 * head が gap（文書先頭/末尾の widget 境界 = 退避先の行が無い位置）にあるかを返す。
 */
function gapAt(state: EditorState, head: number): "bof" | "eof" | null {
	if (head !== 0 && head !== state.doc.length) return null;
	const decos = state.field(tableDecorationField, false)?.decos;
	if (!decos) return null;
	const iter = decos.iter();
	while (iter.value) {
		if (head === 0 && iter.from === 0) return "bof";
		if (head === state.doc.length && iter.to === state.doc.length) return "eof";
		iter.next();
	}
	return null;
}

/**
 * 文書中間のテーブル境界に来たカーソルを隣接行へ退避し、巨大キャレットを防ぐ。
 *
 * - 末尾境界（to）→ 次行先頭へ
 * - 先頭境界（from）→ 前行末尾へ
 *
 * 文書先頭/末尾の境界（退避先の行が無い）は gap としてそのまま許容し、文書は一切
 * 変更しない（#167）。gap での描画は tableGapCursorLayer が、入力時の改行補填は
 * tableGapMaterialize / tableGapImeKeydown が担う。
 */
const tableCursorFilter = EditorState.transactionFilter.of((tr) => {
	if (!tr.selection) return tr;
	// undo / redo は履歴上の状態を忠実に復元するためのトランザクションなので、ここで
	// カーソルを別位置に動かさない（さもないと undo 順序が直感と合わなくなる）。
	const ev = tr.annotation(Transaction.userEvent);
	if (ev === "undo" || ev === "redo") return tr;

	const { starts, ends } = tableBoundaries(tr);
	if (starts.size === 0) return tr;

	const doc = tr.newDoc;
	let modified = false;
	const ranges = tr.selection.ranges.map((range) => {
		if (!range.empty) return range;

		if (ends.has(range.head) && range.head !== doc.length) {
			modified = true;
			return EditorSelection.cursor(range.head + 1);
		}

		if (starts.has(range.head) && range.head !== 0) {
			modified = true;
			return EditorSelection.cursor(range.head - 1);
		}

		return range;
	});

	if (!modified) return tr;
	const selection = EditorSelection.create(ranges, tr.selection.mainIndex);
	// selection は tr 適用後（newDoc）の座標で計算済みなので sequential で扱い、
	// tr.changes による二重マップを避ける。
	return [tr, { selection, sequential: true }];
});

/** IME 先行 materialize（tableGapImeKeydown）由来の tr に付け、二重補填を防ぐ。 */
const gapMaterialized = Annotation.define<boolean>();

/**
 * gap への挿入に改行を補い、入力テキストがテーブルの Markdown 行に食い込んで構文を
 * 壊すのを防ぐ（gap cursor の materialize、#167）。
 *
 * - BOF gap への挿入 → `<入力>\n`（テーブルの前に行ができる）
 * - EOF gap への挿入 → `\n<入力>`（テーブルの後ろに行ができる）
 *
 * 挿入テキスト自身がテーブルと反対側の端で改行している場合（gap での Enter や
 * 改行終わりのペースト）は分離が既に成立しているので補わない。typing / paste は
 * ここで変形する。IME は composition 開始後の文書変更が Chromium で composition を
 * 壊すため tableGapImeKeydown の先行 materialize が担い、その tr は gapMaterialized
 * annotation で本 filter をスキップする。
 *
 * `tr.selection` の無い changes-only dispatch ではカーソルは CM デフォルト（挿入位置の
 * 前に留まる）に従う。貼り付け等の UI 経路は dispatch 側で selection を明示すること
 * （MarkdownEditor の右クリック貼り付け参照）。
 */
const tableGapMaterialize = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged) return tr;
	if (tr.annotation(gapMaterialized)) return tr;
	const ev = tr.annotation(Transaction.userEvent);
	if (ev === "undo" || ev === "redo") return tr;

	// gap 判定は挿入前（startState）の decoration で行う
	const startDoc = tr.startState.doc;
	const bofGap = gapAt(tr.startState, 0) === "bof";
	const eofGap = gapAt(tr.startState, startDoc.length) === "eof";
	if (!bofGap && !eofGap) return tr;

	// 補う \n を「元 changes 適用後（tr.newDoc）」座標で集める。toString()（rope の
	// 平坦化）は gap 端への挿入と確定してから呼ぶ。
	const extraInserts: { from: number; insert: string }[] = [];
	tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
		if (fromA !== toA || inserted.length === 0) return;
		if (bofGap && fromA === 0) {
			if (!inserted.toString().endsWith("\n")) {
				extraInserts.push({ from: fromB + inserted.length, insert: "\n" });
			}
		} else if (eofGap && fromA === startDoc.length) {
			if (!inserted.toString().startsWith("\n")) {
				extraInserts.push({ from: fromB, insert: "\n" });
			}
		}
	});
	if (extraInserts.length === 0) return tr;

	const extra = ChangeSet.of(extraInserts, tr.newDoc.length);
	// assoc -1: 補った \n の挿入点ちょうどの座標（typing 後のカーソル = 挿入テキスト直後）
	// を \n の前側に留める。
	const selection = tr.selection
		? EditorSelection.create(
				tr.selection.ranges.map((r) =>
					EditorSelection.range(extra.mapPos(r.anchor, -1), extra.mapPos(r.head, -1)),
				),
				tr.selection.mainIndex,
			)
		: undefined;
	// 追加 spec として返す（spec 丸ごとの再構築をしない）。merge 時に元 tr の annotations
	// は引き継がれ、effects は補った \n でマップされる。sequential なので changes は
	// tr.newDoc 基準・selection は最終 doc 基準として扱われる。
	return [tr, { changes: extra, selection, sequential: true }];
});

// gap cursor の見た目（ProseMirror の gapcursor 相当の水平バー）
const GAP_CURSOR_WIDTH = 20;
const GAP_CURSOR_HEIGHT = 2;
/** widget 端からバーまでの距離（.cm-table-widget の上下 margin 4px の中に収める） */
const GAP_CURSOR_OFFSET = 3;

/**
 * gap cursor の描画レイヤー（#167）。BOF/EOF gap にカーソルがあるとき、テーブル widget
 * の直上/直下に水平バーを描く（ProseMirror gapcursor 相当の見た目）。drawSelection の
 * cursorLayer は widget 境界で widget 全高の巨大キャレットを描いてしまうため、gap 滞在中
 * は tableGapActiveClass + theme の CSS で primary cursor を隠し、このレイヤーが代わりを
 * 担う。表示・blink は theme 側 CSS（.cm-table-gap-cursor）で制御する。
 */
const tableGapCursorLayer = layer({
	above: true,
	class: "cm-tableGapCursorLayer",
	markers(view) {
		const markers: RectangleMarker[] = [];
		const { state } = view;
		// セル編集中は anchorEditorToTable が selection をテーブル先頭境界へ置くため
		// selection だけでは gap と区別できない。セルフォーカス中は gap バーを描かない（#167）。
		if (state.field(tableCellFocusField, false)) return markers;
		for (const r of state.selection.ranges) {
			if (!r.empty) continue;
			const gap = gapAt(state, r.head);
			if (!gap) continue;
			// 境界へのキャレット矩形は block widget 全体の矩形になる（巨大キャレットと同じ
			// 挙動）。forRange でその base 補正済み矩形を取り、上端/下端へバーを置き直す。
			const [widgetRect] = RectangleMarker.forRange(
				view,
				"cm-table-gap-cursor",
				EditorSelection.cursor(r.head, gap === "bof" ? 1 : -1),
			);
			if (!widgetRect) continue;
			const top =
				gap === "bof"
					? widgetRect.top - GAP_CURSOR_OFFSET - GAP_CURSOR_HEIGHT
					: widgetRect.top + widgetRect.height + GAP_CURSOR_OFFSET;
			markers.push(
				new RectangleMarker(
					"cm-table-gap-cursor",
					widgetRect.left,
					top,
					GAP_CURSOR_WIDTH,
					GAP_CURSOR_HEIGHT,
				),
			);
		}
		return markers;
	},
	update(update) {
		return (
			update.docChanged ||
			update.selectionSet ||
			update.geometryChanged ||
			update.viewportChanged ||
			// セルフォーカス field の変化でも再計算する（gap バーの表示/非表示が切り替わる, #167）
			update.startState.field(tableCellFocusField, false) !==
				update.state.field(tableCellFocusField, false)
		);
	},
});

/**
 * gap 滞在中（main selection が gap）にエディタへ .cm-table-gap-active を付け、theme 側
 * で drawSelection の primary cursor（widget 全高の巨大キャレット）を隠す。
 */
const tableGapActiveClass = EditorView.editorAttributes.of((view) => {
	// セル編集中は anchorEditorToTable が selection をテーブル先頭境界に置くため gap 判定が
	// 真になるが、実フォーカスはセル内にある。巨大キャレットも出ないのでクラスを付けない（#167）。
	if (view.state.field(tableCellFocusField, false)) return null;
	return gapAt(view.state, view.state.selection.main.head)
		? { class: "cm-table-gap-active" }
		: null;
});

/**
 * IME 入力の gap materialize（#167）。Chromium は composition 開始後の文書変更で
 * composition を確定・中断するため、transactionFilter（tableGapMaterialize）での変形
 * では composition 中の入力が壊れる。IME 開始の keydown（keyCode 229）の時点で gap に
 * 空行を先行して作り、composition を通常の行の上で開始させる。
 * keyCode は deprecated だが、composition 開始「前」を捕まえられる唯一のフックであり、
 * CM6 自身も inputState.keydown で keyCode 229 を composition 判定に使っている。
 */
const tableGapImeKeydown = EditorView.domEventHandlers({
	keydown(event, view) {
		if (event.keyCode !== 229) return false;
		const { state } = view;
		const head = state.selection.main.head;
		const gap = gapAt(state, head);
		if (!gap) return false;
		view.dispatch({
			changes: { from: head, insert: "\n" },
			// BOF は補った空行の行頭（= 0）、EOF は補った空行の行頭（= 改行の直後）
			selection: EditorSelection.cursor(gap === "bof" ? 0 : head + 1),
			userEvent: "input",
			annotations: gapMaterialized.of(true),
		});
		return false;
	},
});

// ── Extension ─────────────────────────────────────────

export const tableDecoration: Extension = [
	tableDecorationField,
	tableCellFocusField,
	// treeChangeDispatcher は mermaidDecoration でも include される (dedup は
	// mermaid.ts の同名 include コメント参照)。
	treeChangeDispatcher,
	tableWidgetPositionSync,
	tableAtomicRanges,
	// 同一 precedence の transactionFilter は登録の逆順に適用される（@codemirror/state の
	// filterTransaction は facet 値を末尾から走査する）。materialize → cursorFilter の
	// 実行順にしたいので cursorFilter を先に並べる。これで materialize が [tr, extra] を
	// 返すケースでも、合成後の transaction に対して cursorFilter が tr.state を 1 回だけ
	// 強制評価する（両 filter は作用対象が重ならないため、結果自体は順序非依存）。
	tableCursorFilter,
	tableGapMaterialize,
	tableGapImeKeydown,
	tableGapCursorLayer,
	tableGapActiveClass,
];
