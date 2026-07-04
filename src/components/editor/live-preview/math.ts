import { syntaxTree } from "@codemirror/language";
import {
	EditorSelection,
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
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import katex from "katex";
import { isEscaped } from "../../../lib/content";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";

export { isEscaped };

// Lenient $$...$$ match (position-independent). markdown-to-html.ts の
// preprocessDisplayMath と寛容さを揃えており、Live Preview と PDF のパリティを
// 保証している (#169)。マッチ規則を変更する際は両方を同期すること。
// markdown-to-html.ts 側では、複数行 display を preprocessDisplayMath が、単一行
// display と inline を marked の inline tokenizer extension（INLINE_DISPLAY_MATH_RE /
// INLINE_MATH_RE — 下記と同形 regex の先頭アンカー版）が担当する。
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

/**
 * ドキュメント全体の code ranges を tree 変更時のみ再計算してキャッシュする StateField。
 * math / wikilinks / link-cards からの重複呼び出し (large doc で毎回 tree 全走査していた) を
 * 単一 pass に集約する。selection / focus 変更では再計算しない。
 */
export const codeRangesField = StateField.define<CodeRange[]>({
	create(state) {
		return collectCodeRanges(syntaxTree(state), 0, state.doc.length);
	},
	update(prev, tr) {
		if (!tr.docChanged && syntaxTree(tr.state) === syntaxTree(tr.startState)) return prev;
		return collectCodeRanges(syntaxTree(tr.state), 0, tr.state.doc.length);
	},
});

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

export function buildMathDecorations(state: EditorState, hasFocus: boolean): DecorationSet {
	const cursorLines = collectCursorLines(state, hasFocus);
	const ranges: Range<Decoration>[] = [];

	const docLength = state.doc.length;
	const text = state.doc.sliceString(0, docLength);
	// codeRangesField が include されていないテストでは fallback で計算する
	const codeRanges =
		state.field(codeRangesField, false) ?? collectCodeRanges(syntaxTree(state), 0, docLength);
	const localDisplayRanges: CodeRange[] = [];

	// Pass 1: Display math ($$...$$). Block decoration → must be on a StateField.
	for (const match of text.matchAll(DISPLAY_MATH_RE)) {
		const matchFrom = match.index;
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
				block: true,
			}).range(matchFrom, matchTo),
		);
	}

	// Pass 2: Inline math ($...$).
	// Blank out display math and code ranges so the regex does not consume $ from those regions.
	let textForInline = text;
	if (localDisplayRanges.length > 0 || codeRanges.length > 0) {
		const allRanges = [...localDisplayRanges, ...codeRanges]
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
		const matchFrom = match.index;
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

	return Decoration.set(ranges, true);
}

const rebuildMathDecos = StateEffect.define<boolean>();

const mathHasFocusField = StateField.define<boolean>({
	create() {
		return false;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(rebuildMathDecos)) return e.value;
		}
		return value;
	},
});

const mathDecorationField = StateField.define<DecorationSet>({
	create(state) {
		return buildMathDecorations(state, false);
	},
	update(decos, tr) {
		for (const e of tr.effects) {
			if (e.is(rebuildMathDecos)) {
				return buildMathDecorations(tr.state, e.value);
			}
		}
		if (tr.docChanged) {
			return buildMathDecorations(tr.state, tr.state.field(mathHasFocusField));
		}
		if (tr.selection) {
			const hasFocus = tr.state.field(mathHasFocusField);
			const oldLines = collectCursorLines(tr.startState, tr.startState.field(mathHasFocusField));
			const newLines = collectCursorLines(tr.state, hasFocus);
			if (cursorLinesChanged(oldLines, newLines)) {
				return buildMathDecorations(tr.state, hasFocus);
			}
		}
		return decos;
	},
	provide: (f) => EditorView.decorations.from(f),
});

const mathFocusHandler = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (update.focusChanged) {
				const { view } = update;
				queueMicrotask(() => {
					view.dispatch({ effects: rebuildMathDecos.of(view.hasFocus) });
				});
			}
		}
	},
);

/**
 * Click handler for math widgets. Returns true to suppress the editor's
 * default range-selection behaviour. ignoreEvent()=>false on the widget
 * lets the editor place the cursor normally if this handler does not match.
 */
function createMathClickHandler() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, view: EditorView) {
			const target = event.target as HTMLElement;
			const mathEl = target.closest(".cm-math-inline, .cm-math-display");
			if (!mathEl) return false;

			const decorations = view.state.field(mathDecorationField, false);
			if (!decorations) return false;

			const pos = view.posAtDOM(mathEl);
			let endPos = -1;

			const iter = decorations.iter();
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
	codeRangesField,
	mathHasFocusField,
	mathDecorationField,
	mathFocusHandler,
	createMathClickHandler(),
	dollarInputHandler,
	dollarBackspace,
];
