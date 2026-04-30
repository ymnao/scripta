import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type Extension, type Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import katex from "katex";
import { isEscaped } from "../../../lib/content";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";

export { isEscaped };

const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_MATH_RE = /\$((?:[^\n$\\]|\\.)+)\$/g;

interface CodeRange {
	from: number;
	to: number;
}

/** Collect the document ranges occupied by FencedCode, InlineCode, and CodeBlock nodes. */
export function collectCodeRanges(
	tree: ReturnType<typeof syntaxTree>,
	from: number,
	to: number,
): CodeRange[] {
	const ranges: CodeRange[] = [];
	tree.iterate({
		from,
		to,
		enter(node) {
			if (
				node.name === "FencedCode" ||
				node.name === "InlineCode" ||
				node.name === "CodeBlock" ||
				node.name === "CodeMark" ||
				node.name === "CodeText"
			) {
				ranges.push({ from: node.from, to: node.to });
			}
		},
	});
	return ranges;
}

export function overlapsCodeBlock(from: number, to: number, codeRanges: CodeRange[]): boolean {
	for (const range of codeRanges) {
		if (from < range.to && to > range.from) return true;
	}
	return false;
}

export class MathWidget extends WidgetType {
	tex: string;
	displayMode: boolean;
	constructor(tex: string, displayMode: boolean) {
		super();
		this.tex = tex;
		this.displayMode = displayMode;
	}

	eq(other: MathWidget): boolean {
		return this.tex === other.tex && this.displayMode === other.displayMode;
	}

	toDOM(): HTMLElement {
		const wrap = document.createElement("span");
		wrap.className = this.displayMode ? "cm-math-display" : "cm-math-inline";
		try {
			katex.render(this.tex, wrap, {
				displayMode: this.displayMode,
				throwOnError: false,
			});
		} catch {
			wrap.className = "cm-math-error";
			wrap.textContent = this.tex;
		}
		return wrap;
	}

	ignoreEvent(_event: Event): boolean {
		return false;
	}
}

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = collectCursorLines(view);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		const text = state.doc.sliceString(from, to);
		const codeRanges = collectCodeRanges(tree, from, to);
		const localDisplayRanges: CodeRange[] = [];

		// Pass 1: Display math ($$...$$)
		for (const match of text.matchAll(DISPLAY_MATH_RE)) {
			const matchFrom = from + match.index;
			const matchTo = matchFrom + match[0].length;

			if (isEscaped(text, match.index)) continue;
			const closingDisplayPos = match.index + match[0].length - 2;
			if (isEscaped(text, closingDisplayPos)) continue;
			if (overlapsCodeBlock(matchFrom, matchTo, codeRanges)) continue;

			const startLine = state.doc.lineAt(matchFrom).number;
			const endLine = state.doc.lineAt(matchTo).number;
			if (cursorInRange(cursorLines, startLine, endLine)) continue;

			const tex = match[1];
			localDisplayRanges.push({ from: matchFrom, to: matchTo });
			ranges.push(
				Decoration.replace({
					widget: new MathWidget(tex, true),
				}).range(matchFrom, matchTo),
			);
		}

		// Pass 2: Inline math ($...$)
		// Blank out display math and code ranges so the regex does not
		// consume $ characters that belong to those regions.
		let textForInline = text;
		if (localDisplayRanges.length > 0 || codeRanges.length > 0) {
			const allRanges = [...localDisplayRanges, ...codeRanges]
				.map((r) => ({
					from: Math.max(r.from - from, 0),
					to: Math.min(r.to - from, text.length),
				}))
				.filter((r) => r.from < r.to)
				.sort((a, b) => a.from - b.from);

			const parts: string[] = [];
			let pos = 0;
			for (const r of allRanges) {
				if (r.from > pos) parts.push(text.slice(pos, r.from));
				const blankLen = r.to - Math.max(r.from, pos);
				if (blankLen > 0) parts.push(" ".repeat(blankLen));
				pos = Math.max(pos, r.to);
			}
			if (pos < text.length) parts.push(text.slice(pos));
			textForInline = parts.join("");
		}

		for (const match of textForInline.matchAll(INLINE_MATH_RE)) {
			const matchFrom = from + match.index;
			const matchTo = matchFrom + match[0].length;

			if (isEscaped(textForInline, match.index)) continue;
			const closingInlinePos = match.index + match[0].length - 1;
			if (isEscaped(textForInline, closingInlinePos)) continue;

			// Ensure the match does not span across blanked-out code/display regions
			if (overlapsCodeBlock(matchFrom, matchTo, codeRanges)) continue;
			if (localDisplayRanges.some((dr) => !(matchTo <= dr.from || matchFrom >= dr.to))) continue;

			const lineNum = state.doc.lineAt(matchFrom).number;
			if (cursorLines.has(lineNum)) continue;

			const tex = match[1];
			ranges.push(
				Decoration.replace({
					widget: new MathWidget(tex, false),
				}).range(matchFrom, matchTo),
			);
		}
	}

	return Decoration.set(ranges, true);
}

class MathDecorationPlugin implements PluginValue {
	decorations: DecorationSet;
	prevCursorLines: Set<number>;
	private view: EditorView;
	private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingRebuild = false;
	private destroyed = false;

	constructor(view: EditorView) {
		this.view = view;
		this.decorations = buildDecorations(view);
		this.prevCursorLines = collectCursorLines(view);
	}

	update(update: ViewUpdate) {
		this.view = update.view;

		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}

		if (this.pendingRebuild) {
			this.pendingRebuild = false;
			this.decorations = buildDecorations(update.view);
			this.prevCursorLines = collectCursorLines(update.view);
			return;
		}

		if (update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
			this.cancelRebuild();
			this.decorations = buildDecorations(update.view);
			this.prevCursorLines = collectCursorLines(update.view);
		} else if (update.docChanged) {
			this.decorations = this.decorations.map(update.changes);
			this.prevCursorLines = collectCursorLines(update.view);
			this.scheduleRebuild();
		} else if (update.selectionSet || update.focusChanged) {
			const next = collectCursorLines(update.view);
			if (cursorLinesChanged(this.prevCursorLines, next)) {
				this.prevCursorLines = next;
				this.decorations = buildDecorations(update.view);
			}
		}
	}

	private scheduleRebuild() {
		if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
		this.rebuildTimer = setTimeout(() => {
			this.rebuildTimer = null;
			if (this.destroyed) return;
			if (this.view.composing) {
				this.scheduleRebuild();
				return;
			}
			this.pendingRebuild = true;
			this.view.dispatch({});
		}, 150);
	}

	private cancelRebuild() {
		if (this.rebuildTimer) {
			clearTimeout(this.rebuildTimer);
			this.rebuildTimer = null;
		}
	}

	destroy() {
		this.destroyed = true;
		this.cancelRebuild();
	}
}

const mathPlugin = ViewPlugin.fromClass(MathDecorationPlugin, {
	decorations: (v) => v.decorations,
});

/**
 * Click handler for math widgets.
 * domEventHandlers runs before the editor's built-in mousedown processing,
 * so returning true prevents the default range-selection behaviour.
 * If this handler somehow fails to match, ignoreEvent()=>false lets the
 * editor place the cursor normally as a fallback.
 */
function createMathClickHandler() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, view: EditorView) {
			const target = event.target as HTMLElement;
			const mathEl = target.closest(".cm-math-inline, .cm-math-display");
			if (!mathEl) return false;

			// Use the plugin's own decoration set to find the exact range
			const plugin = view.plugin(mathPlugin);
			if (!plugin) return false;

			const pos = view.posAtDOM(mathEl);
			let endPos = -1;

			// Search for the decoration that covers `pos`
			const iter = plugin.decorations.iter();
			while (iter.value) {
				if (iter.from <= pos && pos <= iter.to) {
					endPos = iter.to;
					break;
				}
				if (iter.from > pos) break;
				iter.next();
			}

			if (endPos === -1) return false;

			event.preventDefault();
			view.dispatch({ selection: EditorSelection.cursor(endPos) });
			view.focus();
			return true;
		},
	});
}

/**
 * Auto-close `$` like brackets/quotes:
 * - Typing `$` inserts `$$` with cursor between
 * - Typing `$` when next char is `$` skips over it
 */
const dollarInputHandler = EditorView.inputHandler.of((view, _from, _to, insert) => {
	if (insert !== "$") return false;

	const { state } = view;

	// Handle each selection range
	const changes = state.changeByRange((range) => {
		const pos = range.from;
		const nextChar = state.doc.sliceString(pos, pos + 1);

		// Skip-over: if cursor is right before a `$`, just move past it
		if (range.empty && nextChar === "$") {
			return {
				range: EditorSelection.cursor(pos + 1),
				changes: { from: pos, to: pos, insert: "" },
			};
		}

		// Selection wrapping: wrap selected text in $...$
		if (!range.empty) {
			return {
				range: EditorSelection.cursor(range.to + 2),
				changes: [
					{ from: range.from, insert: "$" },
					{ from: range.to, insert: "$" },
				],
			};
		}

		// Auto-close: insert $$ with cursor between
		return {
			range: EditorSelection.cursor(range.from + 1),
			changes: { from: range.from, to: range.to, insert: "$$" },
		};
	});

	view.dispatch(changes, { scrollIntoView: true, userEvent: "input" });
	return true;
});

/** Backspace between empty `$$` deletes both. */
const dollarBackspace = keymap.of([
	{
		key: "Backspace",
		run(view) {
			const { state } = view;
			// Only handle if all ranges are empty cursors between $$
			for (const range of state.selection.ranges) {
				if (!range.empty) return false;
				const pos = range.from;
				if (pos === 0 || pos >= state.doc.length) return false;
				const before = state.doc.sliceString(pos - 1, pos);
				const after = state.doc.sliceString(pos, pos + 1);
				if (before !== "$" || after !== "$") return false;
			}

			view.dispatch(
				state.changeByRange((range) => ({
					range: EditorSelection.cursor(range.from - 1),
					changes: { from: range.from - 1, to: range.from + 1 },
				})),
				{ scrollIntoView: true, userEvent: "delete" },
			);
			return true;
		},
	},
]);

export const mathDecoration: Extension = [
	mathPlugin,
	createMathClickHandler(),
	dollarInputHandler,
	dollarBackspace,
];
