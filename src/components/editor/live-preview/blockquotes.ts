import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, type Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

const blockquoteLineDecoration = Decoration.line({
	attributes: { class: "cm-blockquote-line" },
});
const replaceDecoration = Decoration.replace({ inclusiveStart: true });

const blockquoteMarkPattern = /^((?:> ?)+)/;

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name !== "Blockquote") return;

				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);

				// Add line decoration and hide QuoteMarks per line
				for (let l = startLine.number; l <= endLine.number; l++) {
					const line = state.doc.line(l);
					ranges.push(blockquoteLineDecoration.range(line.from, line.from));

					tree.iterate({
						from: line.from,
						to: line.to,
						enter(child) {
							if (child.name !== "QuoteMark") return;
							let replaceEnd = child.to;
							if (
								replaceEnd < state.doc.length &&
								state.doc.sliceString(replaceEnd, replaceEnd + 1) === " "
							) {
								replaceEnd += 1;
							}
							ranges.push(replaceDecoration.range(child.from, replaceEnd));
						},
					});
				}

				// Prevent processing nested Blockquote nodes again
				return false;
			},
		});
	}

	return Decoration.set(ranges, true);
}

class BlockquoteDecorationPlugin implements PluginValue {
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

const blockquoteDecorationPlugin = ViewPlugin.fromClass(BlockquoteDecorationPlugin, {
	decorations: (v) => v.decorations,
	provide: (plugin) =>
		EditorView.atomicRanges.of((view) => {
			return view.plugin(plugin)?.decorations ?? Decoration.none;
		}),
});

/**
 * Prevent the cursor from stopping at line.from of a blockquote line
 * (which is inside the hidden "> " marks). Instead:
 * - Left arrow from the visual start → jump to previous line end
 * - Any other navigation (Home, click, Down) → jump to after marks
 */
const blockquoteCursorFilter = EditorState.transactionFilter.of((tr) => {
	if (!tr.selection) return tr;

	const doc = tr.newDoc;
	let modified = false;
	const oldRanges = tr.startState.selection.ranges;
	const ranges = tr.selection.ranges.map((range, i) => {
		if (!range.empty) return range;

		const pos = range.head;
		const line = doc.lineAt(pos);

		if (pos !== line.from) return range;

		const match = line.text.match(blockquoteMarkPattern);
		if (!match) return range;

		const afterMarks = line.from + match[0].length;

		if (!tr.docChanged) {
			const oldPos = (oldRanges[i] ?? oldRanges[0]).head;
			if (
				tr.startState.doc.lineAt(oldPos).number === line.number &&
				oldPos === afterMarks &&
				line.from > 0
			) {
				modified = true;
				return EditorSelection.cursor(line.from - 1);
			}
			if (line.from === 0) return range;
		}

		modified = true;
		return EditorSelection.cursor(afterMarks);
	});

	if (!modified) return tr;
	return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }];
});

export const blockquoteDecoration: Extension = [blockquoteDecorationPlugin, blockquoteCursorFilter];
