import { syntaxTree } from "@codemirror/language";
import {
	type ChangeSpec,
	EditorSelection,
	EditorState,
	Prec,
	type Range,
	Transaction,
} from "@codemirror/state";
import {
	type Command,
	Decoration,
	type DecorationSet,
	type EditorView,
	keymap,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";

export class BulletWidget extends WidgetType {
	eq(_other: BulletWidget): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const container = document.createElement("span");
		container.className = "cm-list-marker";
		const span = document.createElement("span");
		span.className = "cm-bullet-mark";
		span.textContent = "•";
		container.appendChild(span);
		return container;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export class CheckboxWidget extends WidgetType {
	checked: boolean;
	pos: number;
	constructor(checked: boolean, pos: number) {
		super();
		this.checked = checked;
		this.pos = pos;
	}

	eq(other: CheckboxWidget): boolean {
		return this.checked === other.checked && this.pos === other.pos;
	}

	toDOM(): HTMLElement {
		const container = document.createElement("span");
		container.className = "cm-list-marker";
		const span = document.createElement("span");
		span.className = `cm-task-checkbox${this.checked ? " cm-task-checkbox-checked" : ""}`;
		span.dataset.pos = String(this.pos);
		span.setAttribute("role", "checkbox");
		span.setAttribute("aria-checked", String(this.checked));
		span.setAttribute("aria-label", "Toggle task");
		span.tabIndex = 0;
		if (this.checked) {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
			svg.setAttribute("aria-hidden", "true");
			svg.classList.add("cm-task-checkmark");
			const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
			path.setAttribute("points", "3.5 8 6.5 11 12.5 5");
			path.setAttribute("stroke", "currentColor");
			path.setAttribute("stroke-width", "2");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			svg.appendChild(path);
			span.appendChild(svg);
		}
		container.appendChild(span);
		return container;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name === "Task") {
					const line = state.doc.lineAt(node.from);

					// Find TaskMarker inside Task node
					const taskNode = node.node;
					let taskMarkerFrom = -1;
					let taskMarkerTo = -1;
					let checked = false;

					const taskCursor = taskNode.cursor();
					if (taskCursor.firstChild()) {
						do {
							if (taskCursor.name === "TaskMarker") {
								taskMarkerFrom = taskCursor.from;
								taskMarkerTo = taskCursor.to;
								const markerText = state.doc.sliceString(taskCursor.from, taskCursor.to);
								checked = markerText === "[x]" || markerText === "[X]";
								break;
							}
						} while (taskCursor.nextSibling());
					}

					if (taskMarkerFrom === -1) return;

					// Find ListMark in parent ListItem
					const parent = taskNode.parent;
					if (!parent || parent.name !== "ListItem") return;

					let listMarkFrom = -1;
					const parentCursor = parent.cursor();
					if (parentCursor.firstChild()) {
						do {
							if (parentCursor.name === "ListMark") {
								listMarkFrom = parentCursor.from;
								break;
							}
						} while (parentCursor.nextSibling());
					}

					if (listMarkFrom === -1) return;

					// Consume TaskMarker trailing space
					let replaceEnd = taskMarkerTo;
					if (replaceEnd < line.to && state.doc.sliceString(replaceEnd, replaceEnd + 1) === " ") {
						replaceEnd += 1;
					}

					// Replace ListMark through TaskMarker with checkbox widget
					ranges.push(
						Decoration.replace({
							widget: new CheckboxWidget(checked, taskMarkerFrom),
						}).range(listMarkFrom, taskMarkerTo),
					);

					// Hide trailing space separately (keeps cursor away from widget boundary)
					if (replaceEnd > taskMarkerTo) {
						ranges.push(Decoration.replace({}).range(taskMarkerTo, replaceEnd));
					}

					// Apply strikethrough for checked tasks
					if (checked) {
						const contentFrom = replaceEnd;
						const lineEnd = line.to;
						if (contentFrom < lineEnd) {
							ranges.push(
								Decoration.mark({ class: "cm-task-checked" }).range(contentFrom, lineEnd),
							);
						}
					}
					return;
				}

				if (node.name === "ListItem") {
					const listItemNode = node.node;
					const parent = listItemNode.parent;
					if (!parent || parent.name !== "BulletList") return;

					// Skip if this ListItem contains a Task child
					const itemCursor = listItemNode.cursor();
					if (itemCursor.firstChild()) {
						do {
							if (itemCursor.name === "Task") return;
						} while (itemCursor.nextSibling());
					}

					// Find ListMark and replace marker + trailing space with bullet widget
					const markCursor = listItemNode.cursor();
					if (markCursor.firstChild()) {
						do {
							if (markCursor.name === "ListMark") {
								const line = state.doc.lineAt(node.from);
								const afterMark = markCursor.to;
								// Only decorate when followed by a space (e.g. "- ")
								if (
									afterMark >= line.to ||
									state.doc.sliceString(afterMark, afterMark + 1) !== " "
								) {
									break;
								}
								const replaceEnd = afterMark + 1;
								ranges.push(
									Decoration.replace({
										widget: new BulletWidget(),
									}).range(markCursor.from, replaceEnd),
								);
								break;
							}
						} while (markCursor.nextSibling());
					}
				}
			},
		});
	}

	return Decoration.set(ranges, true);
}

class ListDecorationPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}
		if (
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

/**
 * 行頭の `[] ` または `[ ]` を `- [ ] ` に変換するトランザクションフィルタ。
 * closeBrackets により `[` → `[]` が自動生成された後、
 * - `]` を抜けてスペース → `[] ` となるケース
 * - `[]` の中でスペース → `[ ]` となるケース
 * を検出し、タスクリストマーカーに変換する。
 */
const convertBracketToTask = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged) return tr;

	const newDoc = tr.newDoc;
	const changes: { from: number; to: number; insert: string }[] = [];
	let cursorTarget: number | null = null;

	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		const startLine = newDoc.lineAt(fromB).number;
		const endLine = newDoc.lineAt(Math.min(toB, newDoc.length)).number;
		for (let i = startLine; i <= endLine; i++) {
			const line = newDoc.line(i);
			const match = /^([ \t]*)(?:\[\] |\[ \])$/.exec(line.text);
			if (match) {
				const indent = match[1];
				changes.push({
					from: line.from,
					to: line.to,
					insert: `${indent}- [ ] `,
				});
				cursorTarget = line.from + indent.length + 6; // after "- [ ] "
			}
		}
	});

	if (changes.length === 0) return tr;
	return [
		tr,
		{
			changes,
			selection: cursorTarget !== null ? EditorSelection.cursor(cursorTarget) : undefined,
			sequential: true,
		},
	];
});

/**
 * When a task line is split by Enter, the upper line may become
 * `- [ ]` without a trailing space. The Lezer markdown parser only
 * recognises `- [ ] ` (with space) as a Task, so we append the
 * missing space via a transaction filter.
 *
 * Also handles closeBrackets interaction: when `[` auto-inserts `]`,
 * the cursor ends up inside the marker. We move it past the appended
 * space so it lands outside the decoration range.
 */
const ensureTaskMarkerSpace = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged) return tr;

	const newDoc = tr.newDoc;
	const inserts: { from: number; insert: string }[] = [];
	let cursorTarget: number | null = null;

	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		const startLine = newDoc.lineAt(fromB).number;
		const endLine = newDoc.lineAt(Math.min(toB, newDoc.length)).number;
		for (let i = startLine; i <= endLine; i++) {
			const line = newDoc.line(i);
			if (/^[ \t]*[-*+][ \t]\[[ xX]\]$/.test(line.text)) {
				inserts.push({ from: line.to, insert: " " });
				// If cursor is inside the task marker (e.g. closeBrackets put it before ']'),
				// move it past the appended space so typing goes after the checkbox widget.
				const head = tr.newSelection.main.head;
				if (head >= line.from && head < line.to) {
					cursorTarget = line.to + 1;
				}
			}
		}
	});

	if (inserts.length === 0) return tr;
	if (cursorTarget !== null) {
		return [
			tr,
			{ changes: inserts, selection: EditorSelection.cursor(cursorTarget), sequential: true },
		];
	}
	return [tr, { changes: inserts, sequential: true }];
});

/** Matches bullet list markers: `- `, `* `, `+ ` with optional leading indent */
const bulletMarkerRe = /^([ \t]*[-*+] )/;
/** Matches task list markers: `- [ ] `, `- [x] `, etc. with optional leading indent */
const taskMarkerRe = /^([ \t]*[-*+] \[[ xX]\] )/;
/** Matches ordered list markers: `1. `, `12) `, etc. with optional leading indent */
const orderedMarkerRe = /^([ \t]*)(\d+)([.)]) /;
/** Matches any bullet/task marker capturing the indent and the bullet char separately */
const anyBulletRe = /^([ \t]*)([-*+]) (\[[ xX]\] )?/;

/**
 * Fallback indent unit when there is no preceding sibling to copy the content
 * offset from (e.g. Tab on a single isolated list item). Matches the editor's
 * `indentUnit` config so behavior stays consistent with plain text Tab.
 */
const LIST_INDENT_UNIT = "  ";

/**
 * Column where the content of a list item starts (= indent + marker + trailing
 * space). Nesting a sub-item to this column makes the markdown parser treat it
 * as a child of this item, which is required for `insertNewlineContinueMarkup`
 * to scope its `renumberList` to the nested level instead of walking parent
 * siblings.
 */
function listContentOffset(info: ListLineInfo): number {
	if (info.ordered) {
		return info.indent.length + String(info.ordered.number).length + 2;
	}
	if (info.task) {
		return info.indent.length + 6; // "- [ ] " or "- [x] "
	}
	return info.indent.length + 2; // "- "
}

export interface ListLineInfo {
	indent: string;
	ordered: { number: number; delim: "." | ")" } | null;
	task: boolean;
}

/**
 * Pure parser that classifies a single line as an ordered list / bullet list
 * / task list item, or `null` if it is none. Does not consult the syntax tree.
 */
export function parseListLine(text: string): ListLineInfo | null {
	const o = orderedMarkerRe.exec(text);
	if (o) {
		return {
			indent: o[1],
			ordered: { number: Number.parseInt(o[2], 10), delim: o[3] as "." | ")" },
			task: false,
		};
	}
	const b = anyBulletRe.exec(text);
	if (b) {
		return { indent: b[1], ordered: null, task: b[3] != null };
	}
	return null;
}

function isInsideCodeBlock(state: EditorState, pos: number): boolean {
	const tree = syntaxTree(state);
	const node = tree.resolve(pos, 1);
	for (let cur: typeof node | null = node; cur; cur = cur.parent) {
		const name = cur.name;
		if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") {
			return true;
		}
	}
	return false;
}

/**
 * Determine the indent for a line being nested via Tab. Looks backward for the
 * nearest list line at the same current indent (which becomes the parent after
 * Tab) and matches its content offset so the markdown parser treats the result
 * as a true nested list. Falls back to `oldIndent + LIST_INDENT_UNIT` when no
 * suitable sibling exists.
 */
function computeIndentForNest(state: EditorState, lineNum: number, oldIndent: string): string {
	for (let i = lineNum - 1; i >= 1; i--) {
		const text = state.doc.line(i).text;
		if (text.trim() === "") break;
		const info = parseListLine(text);
		if (!info) break;
		if (info.indent.length > oldIndent.length) continue;
		if (info.indent.length < oldIndent.length) break;
		const targetCol = listContentOffset(info);
		if (targetCol <= oldIndent.length) break;
		return " ".repeat(targetCol);
	}
	return oldIndent + LIST_INDENT_UNIT;
}

/**
 * Determine the indent for a line being un-nested via Shift+Tab. Walks back to
 * find the nearest shallower list line (the parent) and matches its indent so
 * the line becomes a sibling of that parent. Falls back to removing one
 * `LIST_INDENT_UNIT` when no ancestor is found.
 */
function computeIndentForOutdent(state: EditorState, lineNum: number, oldIndent: string): string {
	for (let i = lineNum - 1; i >= 1; i--) {
		const text = state.doc.line(i).text;
		if (text.trim() === "") break;
		const info = parseListLine(text);
		if (!info) break;
		if (info.indent.length < oldIndent.length) {
			return info.indent;
		}
	}
	const removeCount = Math.min(oldIndent.length, LIST_INDENT_UNIT.length);
	return oldIndent.slice(removeCount);
}

/**
 * Plan the indent / outdent + renumber changes for the current selection.
 *
 * - `direction = 1`: indent (Tab). Add `LIST_INDENT_UNIT` to every list line in
 *   the selection range.
 * - `direction = -1`: outdent (Shift+Tab). Remove up to `LIST_INDENT_UNIT.length`
 *   leading characters from every list line in the selection range.
 *
 * After applying indent changes, renumber the affected ordered list block so
 * that nested levels start fresh at `1.` (for the modified line) and sibling
 * items continue sequentially. Bullet / task lines are left untouched but break
 * ordered runs of the same indent, matching CommonMark semantics.
 *
 * Returns `null` if no line in the selection is a list item (caller should fall
 * through to the default Tab handler) or if no change is necessary.
 */
export function computeListIndentChanges(
	state: EditorState,
	direction: 1 | -1,
): { changes: ChangeSpec[] } | null {
	const sel = state.selection.main;
	const startLineNum = state.doc.lineAt(sel.from).number;
	const endLineNum = state.doc.lineAt(sel.to).number;

	interface Mod {
		lineNum: number;
		lineFrom: number;
		oldIndent: string;
		newIndent: string;
	}
	const mods: Mod[] = [];

	for (let i = startLineNum; i <= endLineNum; i++) {
		const line = state.doc.line(i);
		if (isInsideCodeBlock(state, line.from)) continue;
		const info = parseListLine(line.text);
		if (!info) continue;

		const oldIndent = info.indent;
		let newIndent: string;
		if (direction === 1) {
			newIndent = computeIndentForNest(state, i, oldIndent);
		} else {
			if (oldIndent.length === 0) continue;
			newIndent = computeIndentForOutdent(state, i, oldIndent);
			if (newIndent.length === oldIndent.length) continue;
		}
		mods.push({ lineNum: i, lineFrom: line.from, oldIndent, newIndent });
	}

	if (mods.length === 0) return null;

	const modMap = new Map(mods.map((m) => [m.lineNum, m]));

	const getVirtualLineText = (lineNum: number): string => {
		const orig = state.doc.line(lineNum).text;
		const m = modMap.get(lineNum);
		if (!m) return orig;
		return m.newIndent + orig.slice(m.oldIndent.length);
	};

	// Walk back/forward from modified lines to find the affected list block.
	// A block is broken by a blank line or a non-list line.
	let blockStart = mods[0].lineNum;
	while (blockStart > 1) {
		const text = getVirtualLineText(blockStart - 1);
		if (text.trim() === "") break;
		if (!parseListLine(text)) break;
		blockStart--;
	}
	let blockEnd = mods[mods.length - 1].lineNum;
	while (blockEnd < state.doc.lines) {
		const text = getVirtualLineText(blockEnd + 1);
		if (text.trim() === "") break;
		if (!parseListLine(text)) break;
		blockEnd++;
	}

	// Per indent depth, track the next expected ordered-list number.
	// - Same indent + bullet/task → break the ordered run at that indent.
	// - Shallower indent → drop counters at deeper indents.
	// - Modified ordered line with no existing counter at its (new) indent →
	//   force a fresh start at 1 (the typical Tab-to-new-sublist case).
	const indentCounters = new Map<string, { next: number }>();
	const renumberMap = new Map<number, number>();

	for (let i = blockStart; i <= blockEnd; i++) {
		const text = getVirtualLineText(i);
		const info = parseListLine(text);
		if (!info) continue;

		for (const k of [...indentCounters.keys()]) {
			if (k.length > info.indent.length) indentCounters.delete(k);
		}

		if (!info.ordered) {
			indentCounters.delete(info.indent);
			continue;
		}

		const existing = indentCounters.get(info.indent);
		if (!existing) {
			const isMod = modMap.has(i);
			const startNum = isMod ? 1 : info.ordered.number;
			if (startNum !== info.ordered.number) renumberMap.set(i, startNum);
			indentCounters.set(info.indent, { next: startNum + 1 });
		} else {
			if (existing.next !== info.ordered.number) renumberMap.set(i, existing.next);
			existing.next += 1;
		}
	}

	// Coalesce per-line edits into a single ChangeSpec covering `[indent + number]`.
	// This avoids zero-length insertions overlapping a replacement at the same offset.
	const lineNums = new Set<number>([...modMap.keys(), ...renumberMap.keys()]);
	const changes: ChangeSpec[] = [];

	for (const lineNum of [...lineNums].sort((a, b) => a - b)) {
		const line = state.doc.line(lineNum);
		const origInfo = parseListLine(line.text);
		if (!origInfo) continue;

		const mod = modMap.get(lineNum);
		const newNum = renumberMap.get(lineNum);

		const oldIndent = origInfo.indent;
		const newIndent = mod ? mod.newIndent : oldIndent;
		const oldNumStr = origInfo.ordered ? String(origInfo.ordered.number) : "";
		const newNumStr = newNum !== undefined ? String(newNum) : oldNumStr;

		if (newIndent === oldIndent && newNumStr === oldNumStr) continue;

		if (newNumStr === oldNumStr || !origInfo.ordered) {
			changes.push({
				from: line.from,
				to: line.from + oldIndent.length,
				insert: newIndent,
			});
		} else {
			changes.push({
				from: line.from,
				to: line.from + oldIndent.length + oldNumStr.length,
				insert: newIndent + newNumStr,
			});
		}
	}

	if (changes.length === 0) return null;
	return { changes };
}

/**
 * Tab handler: indent every list line in the selection and renumber the
 * surrounding ordered list block. Falls through to the default Tab binding
 * (which inserts `indentUnit`) when no list line is involved.
 */
export const indentListMore: Command = (view) => {
	const result = computeListIndentChanges(view.state, 1);
	if (!result) return false;
	view.dispatch(
		view.state.update({
			changes: result.changes,
			userEvent: "input.indent",
		}),
	);
	return true;
};

/**
 * Shift+Tab handler: outdent every list line in the selection and renumber the
 * surrounding ordered list block. Falls through to the default Shift+Tab
 * binding when no list line is involved or all selected list lines are already
 * at column 0.
 */
export const indentListLess: Command = (view) => {
	const result = computeListIndentChanges(view.state, -1);
	if (!result) return false;
	view.dispatch(
		view.state.update({
			changes: result.changes,
			userEvent: "delete.dedent",
		}),
	);
	return true;
};

/**
 * Find the marker range (ListMark + optional TaskMarker + trailing space)
 * for a bullet/task list item on the given line using regex.
 * Returns `{ from, to }` or `null` if not found.
 */
export function findMarkerRange(
	state: EditorState,
	line: { from: number; to: number; number: number },
): { from: number; to: number } | null {
	const text = state.doc.sliceString(line.from, line.to);
	const taskMatch = taskMarkerRe.exec(text);
	const bulletMatch = !taskMatch ? bulletMarkerRe.exec(text) : null;

	if (!taskMatch && !bulletMatch) return null;

	// Guard: don't treat markers inside code blocks as list items.
	// syntaxTree may be partially parsed (no EditorView in tests), in
	// which case ancestors are just Document and the guard is a no-op.
	const tree = syntaxTree(state);
	const node = tree.resolve(line.from, 1);
	for (let cur = node.parent; cur; cur = cur.parent) {
		const name = cur.name;
		if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") {
			return null;
		}
	}

	if (taskMatch) {
		return { from: line.from, to: line.from + taskMatch[1].length };
	}
	// bulletMatch is guaranteed non-null here (early return above ensures
	// at least one of taskMatch/bulletMatch matched).
	const matched = bulletMatch as RegExpExecArray;
	return { from: line.from, to: line.from + matched[1].length };
}

/**
 * Backspace on the content start of a bullet/task list item deletes
 * the entire marker (and task marker) + trailing space in one
 * keystroke, so the line immediately becomes plain text.
 *
 * ArrowLeft at the content start skips the hidden marker area and
 * moves the cursor to the end of the previous line.
 *
 * Wrapped in Prec.high so it runs before defaultKeymap's
 * deleteCharBackward (which always returns true and would otherwise
 * swallow the event).
 */
export const listKeymap = [
	convertBracketToTask,
	ensureTaskMarkerSpace,
	Prec.high(
		keymap.of([
			{
				key: "Backspace",
				run(view) {
					const { state } = view;
					const { main } = state.selection;
					if (!main.empty) return false;

					const head = main.head;
					const line = state.doc.lineAt(head);
					if (head === line.from) return false;

					const range = findMarkerRange(state, line);
					if (!range) return false;
					if (head <= range.from || head > range.to) return false;

					view.dispatch({
						changes: { from: range.from, to: range.to },
						annotations: Transaction.userEvent.of("delete.backward"),
					});
					return true;
				},
			},
			{
				key: "ArrowLeft",
				run(view) {
					const { state } = view;
					const { main } = state.selection;
					if (!main.empty) return false;

					const head = main.head;
					const line = state.doc.lineAt(head);
					const range = findMarkerRange(state, line);
					if (!range) return false;

					// Cursor is within or at the end of the marker area
					if (head > range.from && head <= range.to) {
						if (line.number <= 1) return false;
						const prevLine = state.doc.line(line.number - 1);
						view.dispatch({
							selection: EditorSelection.cursor(prevLine.to),
						});
						return true;
					}
					return false;
				},
			},
			{
				key: "ArrowRight",
				run(view) {
					const { state } = view;
					const { main } = state.selection;
					if (!main.empty) return false;

					const head = main.head;
					const line = state.doc.lineAt(head);

					// At end of line, check if next line has a marker to skip
					if (head === line.to && line.number < state.doc.lines) {
						const nextLine = state.doc.line(line.number + 1);
						const range = findMarkerRange(state, nextLine);
						if (range) {
							view.dispatch({
								selection: EditorSelection.cursor(range.to),
							});
							return true;
						}
					}

					// Inside marker area, jump to content start
					const range = findMarkerRange(state, line);
					if (range && head >= range.from && head < range.to) {
						view.dispatch({
							selection: EditorSelection.cursor(range.to),
						});
						return true;
					}
					return false;
				},
			},
			// Tab / Shift+Tab on list lines: nest/un-nest the item and renumber
			// the surrounding ordered list block (#118). Returns false when no
			// list line is involved so the default indentWithTab handler takes
			// over for plain text and code blocks.
			{ key: "Tab", run: indentListMore },
			{ key: "Shift-Tab", run: indentListLess },
		]),
	),
];

function toggleCheckbox(view: EditorView, checkbox: Element): void {
	const pos = Number((checkbox as HTMLElement).dataset.pos);
	if (Number.isNaN(pos) || pos < 0 || pos + 3 > view.state.doc.length) return;
	const current = view.state.doc.sliceString(pos, pos + 3);
	const newText = current === "[x]" || current === "[X]" ? "[ ]" : "[x]";
	view.dispatch({
		changes: { from: pos, to: pos + 3, insert: newText },
		annotations: Transaction.userEvent.of("input"),
	});
}

export const listDecoration = ViewPlugin.fromClass(ListDecorationPlugin, {
	decorations: (v) => v.decorations,
	eventHandlers: {
		click(event: MouseEvent, view: EditorView) {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const checkbox = target.closest(".cm-task-checkbox");
			if (!checkbox) return;
			event.preventDefault();
			toggleCheckbox(view, checkbox);
		},
		keydown(event: KeyboardEvent, view: EditorView) {
			if (event.key !== " " && event.key !== "Enter") return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			const checkbox = target.closest(".cm-task-checkbox");
			if (!checkbox) return;
			event.preventDefault();
			toggleCheckbox(view, checkbox);
		},
	},
});
