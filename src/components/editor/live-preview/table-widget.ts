import { type EditorView, WidgetType } from "@codemirror/view";
import { cmdOrCtrl } from "../../../lib/keyboard";
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

// ── Widget ────────────────────────────────────────────

let pendingFocus: { tableFrom: number; row: number; col: number } | null = null;

// ESM の import binding は read-only なので、tableDecorationField からの代入は setter を経由する。
export function setPendingFocus(focus: { tableFrom: number; row: number; col: number }): void {
	pendingFocus = focus;
}

/** IME 状態追跡（ウィジェット単位）。compositionActive はコンポジション中に true。
 *  composing は compositionstart で true になり、compositionend 後の
 *  最初の keyup で false になる。これにより確定 Enter の keydown を
 *  確実にスキップできる。 */
const compositionState = new WeakMap<HTMLElement, { active: boolean; composing: boolean }>();

function getCompositionState(el: HTMLElement) {
	return compositionState.get(el) ?? { active: false, composing: false };
}

export class EditableTableWidget extends WidgetType {
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
