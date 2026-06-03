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

const bulletMarkerRe = /^([ \t]*[-*+] )/;
const taskMarkerRe = /^([ \t]*[-*+] \[[ xX]\] )/;
const orderedMarkerRe = /^([ \t]*)(\d+)([.)]) /;
const anyBulletRe = /^([ \t]*)([-*+]) (\[[ xX]\] )?/;

/** Fallback indent step when no preceding sibling exists. */
const LIST_INDENT_UNIT = "  ";

export interface ListLineInfo {
	indent: string;
	ordered: { number: number; delim: "." | ")" } | null;
	task: boolean;
	/** Width of `[marker][trailing space]` (excludes indent). */
	markerWidth: number;
}

/** Classify a line as ordered / bullet / task list item, or `null`. */
export function parseListLine(text: string): ListLineInfo | null {
	const o = orderedMarkerRe.exec(text);
	if (o) {
		return {
			indent: o[1],
			ordered: { number: Number.parseInt(o[2], 10), delim: o[3] as "." | ")" },
			task: false,
			markerWidth: o[0].length - o[1].length,
		};
	}
	const b = anyBulletRe.exec(text);
	if (b) {
		return {
			indent: b[1],
			ordered: null,
			task: b[3] != null,
			markerWidth: b[0].length - b[1].length,
		};
	}
	return null;
}

function isInsideCodeBlock(state: EditorState, pos: number): boolean {
	const tree = syntaxTree(state);
	for (
		let cur: { name: string; parent: typeof cur | null } | null = tree.resolve(pos, 1);
		cur;
		cur = cur.parent
	) {
		const name = cur.name;
		if (name === "FencedCode" || name === "CodeBlock" || name === "IndentedCode") return true;
	}
	return false;
}

/** Leading whitespace width of a line (treats tabs as 1 char). */
function leadingWidth(text: string): number {
	const m = /^[ \t]*/.exec(text);
	return m ? m[0].length : 0;
}

const ATX_HEADING_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_DASH_RE = /^[ \t]{0,3}(?:-[ \t]*){3,}$/;
const THEMATIC_STAR_RE = /^[ \t]{0,3}(?:\*[ \t]*){3,}$/;
const THEMATIC_UNDERSCORE_RE = /^[ \t]{0,3}(?:_[ \t]*){3,}$/;
const BLOCKQUOTE_RE = /^[ \t]{0,3}>/;
const FENCED_CODE_RE = /^[ \t]{0,3}(?:```|~~~)/;
// Block-level HTML tag names that interrupt a paragraph per CommonMark §4.6
// types 1 (script/style/pre/textarea) and 6 (block-level elements). Inline
// tags like <span>, <a>, <em>, <code>, <strong>, and custom elements are not
// in this set — they stay as inline content within the list item.
const HTML_BLOCK_TAGS = new Set([
	// Type 1
	"script",
	"pre",
	"style",
	"textarea",
	// Type 6
	"address",
	"article",
	"aside",
	"base",
	"basefont",
	"blockquote",
	"body",
	"caption",
	"center",
	"col",
	"colgroup",
	"dd",
	"details",
	"dialog",
	"dir",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"frame",
	"frameset",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hr",
	"html",
	"iframe",
	"legend",
	"li",
	"link",
	"main",
	"menu",
	"menuitem",
	"nav",
	"noframes",
	"ol",
	"optgroup",
	"option",
	"p",
	"param",
	"section",
	"source",
	"summary",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"title",
	"tr",
	"track",
	"ul",
]);
// Comment / CDATA / declaration / processing instruction always interrupt.
const HTML_OPENER_RE = /^[ \t]{0,3}<(?:!--|!\[CDATA\[|[!?])/;
// Opening tag `<name` followed by whitespace, `>`, `/`, or EOL. Closing tags
// (`</…`) are intentionally NOT matched: marked keeps a standalone closing
// tag as part of the preceding list item, so treating it as a boundary would
// split lists the parser sees as one block.
const HTML_TAG_RE = /^[ \t]{0,3}<([a-zA-Z][a-zA-Z0-9-]*)(?:[\s>/]|$)/;

function isHtmlBlock(text: string): boolean {
	if (HTML_OPENER_RE.test(text)) return true;
	const m = HTML_TAG_RE.exec(text);
	return m !== null && HTML_BLOCK_TAGS.has(m[1].toLowerCase());
}

/**
 * Lines that interrupt a paragraph in CommonMark and therefore end a list
 * item's lazy continuation: ATX headings, thematic breaks, blockquotes, fenced
 * code blocks, and HTML blocks. Returning `true` here makes the list-block
 * scan and the sibling-search walks treat the line as a hard boundary.
 */
function isParagraphInterrupting(text: string): boolean {
	return (
		ATX_HEADING_RE.test(text) ||
		THEMATIC_DASH_RE.test(text) ||
		THEMATIC_STAR_RE.test(text) ||
		THEMATIC_UNDERSCORE_RE.test(text) ||
		BLOCKQUOTE_RE.test(text) ||
		FENCED_CODE_RE.test(text) ||
		isHtmlBlock(text)
	);
}

/**
 * Walk back to find the closest list line that satisfies `predicate`. Treats
 * indented non-list lines as continuation paragraphs and walks past them,
 * stopping only on blank lines, on non-list lines indented less than
 * `boundaryIndentLen`, or when the predicate returns `"stop"`.
 */
function findPrevListLine(
	state: EditorState,
	lineNum: number,
	boundaryIndentLen: number,
	predicate: (info: ListLineInfo) => boolean | "stop",
): ListLineInfo | null {
	for (let i = lineNum - 1; i >= 1; i--) {
		const text = state.doc.line(i).text;
		if (text.trim() === "") return null;
		const info = parseListLine(text);
		if (!info) {
			if (isParagraphInterrupting(text)) return null;
			if (leadingWidth(text) < boundaryIndentLen) return null;
			continue; // lazy/indented continuation — keep walking
		}
		const r = predicate(info);
		if (r === "stop") return null;
		if (r) return info;
	}
	return null;
}

/**
 * Indent for a line being nested via Tab. Aligns to the preceding same-indent
 * sibling's content offset so the markdown parser sees a true CommonMark
 * nesting; otherwise falls back to one `LIST_INDENT_UNIT`.
 */
function computeIndentForNest(state: EditorState, lineNum: number, oldIndent: string): string {
	const sibling = findPrevListLine(state, lineNum, oldIndent.length, (info) => {
		if (info.indent.length > oldIndent.length) return false;
		if (info.indent.length < oldIndent.length) return "stop";
		return true;
	});
	if (sibling) {
		const targetCol = sibling.indent.length + sibling.markerWidth;
		if (targetCol > oldIndent.length) return " ".repeat(targetCol);
	}
	return oldIndent + LIST_INDENT_UNIT;
}

/**
 * Indent for a line being un-nested via Shift+Tab. Aligns to the nearest
 * shallower ancestor; otherwise drops one `LIST_INDENT_UNIT`.
 */
function computeIndentForOutdent(state: EditorState, lineNum: number, oldIndent: string): string {
	const ancestor = findPrevListLine(
		state,
		lineNum,
		oldIndent.length,
		(info) => info.indent.length < oldIndent.length,
	);
	if (ancestor) return ancestor.indent;
	return oldIndent.slice(Math.min(oldIndent.length, LIST_INDENT_UNIT.length));
}

/**
 * Plan the indent / outdent + renumber changes for the current selection.
 *
 * For each list line in the selection: compute the new indent (Tab nests
 * under the preceding sibling's content offset, Shift+Tab outdents to the
 * ancestor's indent), then renumber the surrounding ordered list block so
 * nested levels start fresh at 1 and sibling items continue sequentially.
 *
 * Returns `null` if no list line is affected — caller should fall through
 * to the default Tab binding.
 */
export function computeListIndentChanges(
	state: EditorState,
	direction: 1 | -1,
): { changes: ChangeSpec[] } | null {
	const sel = state.selection.main;
	const startLineNum = state.doc.lineAt(sel.from).number;
	const endLine = state.doc.lineAt(sel.to);
	// Exclude the trailing line when a non-empty selection ends exactly at
	// its start — matches CM's `changeBySelectedLine` convention so range
	// selections behave like the standard indent / outdent commands.
	const endLineNum = !sel.empty && sel.to === endLine.from ? endLine.number - 1 : endLine.number;
	if (endLineNum < startLineNum) return null;

	// Parse each touched line once and reuse downstream.
	const parsedLines = new Map<number, ListLineInfo>();
	const newIndents = new Map<number, string>();

	const getOrParse = (lineNum: number): ListLineInfo | null => {
		const cached = parsedLines.get(lineNum);
		if (cached) return cached;
		const info = parseListLine(state.doc.line(lineNum).text);
		if (info) parsedLines.set(lineNum, info);
		return info;
	};

	for (let i = startLineNum; i <= endLineNum; i++) {
		const line = state.doc.line(i);
		if (isInsideCodeBlock(state, line.from)) continue;
		const info = parseListLine(line.text);
		if (!info) continue;
		parsedLines.set(i, info);

		const oldIndent = info.indent;
		if (direction === -1 && oldIndent.length === 0) continue;
		const newIndent =
			direction === 1
				? computeIndentForNest(state, i, oldIndent)
				: computeIndentForOutdent(state, i, oldIndent);
		if (newIndent !== oldIndent) newIndents.set(i, newIndent);
	}

	if (newIndents.size === 0) return null;

	// A list block extends through list marker lines, indented continuation
	// paragraphs, and CommonMark "lazy continuation" lines (unindented
	// paragraph text that still belongs to the previous item). It ends at
	// the first blank line OR at a line that interrupts a paragraph in
	// CommonMark (ATX heading, thematic break, blockquote, fenced code).
	const isBlockMember = (lineNum: number): boolean => {
		const text = state.doc.line(lineNum).text;
		if (text.trim() === "") return false;
		if (getOrParse(lineNum)) return true;
		return !isParagraphInterrupting(text);
	};

	const modLineNums = [...newIndents.keys()].sort((a, b) => a - b);
	let blockStart = modLineNums[0];
	while (blockStart > 1 && isBlockMember(blockStart - 1)) blockStart--;
	let blockEnd = modLineNums[modLineNums.length - 1];
	while (blockEnd < state.doc.lines && isBlockMember(blockEnd + 1)) blockEnd++;

	// Per indent depth, track the next expected ordered-list number.
	// Bullet/task at same indent breaks the run; shallower indent drops
	// deeper counters. A modified ordered line with no existing counter at
	// its (new) indent forces a fresh start at 1; for unmodified first items
	// we respect the user-typed number.
	const indentCounters = new Map<string, number>();
	const renumberMap = new Map<number, number>();

	for (let i = blockStart; i <= blockEnd; i++) {
		const orig = getOrParse(i);
		if (!orig) continue;
		const virtualIndent = newIndents.get(i) ?? orig.indent;

		for (const k of indentCounters.keys()) {
			if (k.length > virtualIndent.length) indentCounters.delete(k);
		}

		if (!orig.ordered) {
			indentCounters.delete(virtualIndent);
			continue;
		}

		const existing = indentCounters.get(virtualIndent);
		const startNum = existing ?? (newIndents.has(i) ? 1 : orig.ordered.number);
		if (startNum !== orig.ordered.number) renumberMap.set(i, startNum);
		indentCounters.set(virtualIndent, startNum + 1);
	}

	// Effective indent length of a line (newIndents + already-applied cascade).
	// For continuation paragraphs (non-list), uses raw leading whitespace.
	const indentShifts = new Map<number, number>();
	const effectiveIndentLen = (lineNum: number): number => {
		const orig = getOrParse(lineNum);
		const base = orig
			? (newIndents.get(lineNum)?.length ?? orig.indent.length)
			: leadingWidth(state.doc.line(lineNum).text);
		return base + (indentShifts.get(lineNum) ?? 0);
	};

	// Cascade: when a renumber changes an ordered line's marker width
	// (e.g. 9 → 10), every line in its content-offset scope (descendant
	// list items AND their continuation paragraphs) needs its indent
	// shifted by the same delta so the post-renumber doc still parses as
	// nested under the post-renumber content offset.
	for (let i = blockStart; i <= blockEnd; i++) {
		const orig = getOrParse(i);
		if (!orig?.ordered) continue;
		const newNum = renumberMap.get(i);
		if (newNum === undefined) continue;
		const delta = String(newNum).length - String(orig.ordered.number).length;
		if (delta === 0) continue;

		const lOldContentOffset = effectiveIndentLen(i) + orig.markerWidth;
		for (let j = i + 1; j <= blockEnd; j++) {
			const jLine = state.doc.line(j);
			if (jLine.text.trim() === "") break;
			if (effectiveIndentLen(j) < lOldContentOffset) break;
			indentShifts.set(j, (indentShifts.get(j) ?? 0) + delta);
		}
	}

	// Apply a positive/negative shift to a leading-whitespace string by
	// padding or trimming. Clamps at 0.
	const applyShift = (leading: string, shift: number): string => {
		if (shift > 0) return leading + " ".repeat(shift);
		if (shift < 0) return leading.slice(0, Math.max(0, leading.length + shift));
		return leading;
	};

	// Emit one change per affected line in line order. Block iteration is
	// ascending so no sort step is needed.
	const changes: ChangeSpec[] = [];
	const lineNums = new Set([...newIndents.keys(), ...renumberMap.keys(), ...indentShifts.keys()]);
	for (let i = blockStart; i <= blockEnd; i++) {
		if (!lineNums.has(i)) continue;
		const line = state.doc.line(i);
		const orig = getOrParse(i);

		if (!orig) {
			// Continuation paragraph — only the cascade shift applies.
			const shift = indentShifts.get(i) ?? 0;
			if (shift === 0) continue;
			const m = /^[ \t]*/.exec(line.text);
			const leading = m ? m[0] : "";
			const newLeading = applyShift(leading, shift);
			if (newLeading === leading) continue;
			changes.push({ from: line.from, to: line.from + leading.length, insert: newLeading });
			continue;
		}

		const baseIndent = newIndents.get(i) ?? orig.indent;
		const finalIndent = applyShift(baseIndent, indentShifts.get(i) ?? 0);
		const newNum = renumberMap.get(i);
		const oldNumStr = orig.ordered ? String(orig.ordered.number) : "";
		const newNumStr = newNum !== undefined ? String(newNum) : oldNumStr;

		if (finalIndent === orig.indent && newNumStr === oldNumStr) continue;

		if (newNumStr === oldNumStr || !orig.ordered) {
			changes.push({
				from: line.from,
				to: line.from + orig.indent.length,
				insert: finalIndent,
			});
		} else {
			changes.push({
				from: line.from,
				to: line.from + orig.indent.length + oldNumStr.length,
				insert: finalIndent + newNumStr,
			});
		}
	}

	return changes.length === 0 ? null : { changes };
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
 * for a bullet/task list item on the given line. Returns `null` if the
 * line has no bullet/task marker or if it sits inside a code block.
 */
export function findMarkerRange(
	state: EditorState,
	line: { from: number; to: number; number: number },
): { from: number; to: number } | null {
	const text = state.doc.sliceString(line.from, line.to);
	const match = taskMarkerRe.exec(text) ?? bulletMarkerRe.exec(text);
	if (!match) return null;
	if (isInsideCodeBlock(state, line.from)) return null;
	return { from: line.from, to: line.from + match[1].length };
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
