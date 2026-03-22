import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

const headingLineDecorations = {
	1: Decoration.line({ attributes: { class: "cm-heading-1" } }),
	2: Decoration.line({ attributes: { class: "cm-heading-2" } }),
	3: Decoration.line({ attributes: { class: "cm-heading-3" } }),
	4: Decoration.line({ attributes: { class: "cm-heading-4" } }),
	5: Decoration.line({ attributes: { class: "cm-heading-5" } }),
	6: Decoration.line({ attributes: { class: "cm-heading-6" } }),
} as const;

type HeadingLevel = keyof typeof headingLineDecorations;

const headingNodeNames: ReadonlyMap<string, HeadingLevel> = new Map([
	["ATXHeading1", 1],
	["ATXHeading2", 2],
	["ATXHeading3", 3],
	["ATXHeading4", 4],
	["ATXHeading5", 5],
	["ATXHeading6", 6],
]);

const replaceDecoration = Decoration.replace({ inclusiveStart: true });

const headingMarkPattern = /^(#{1,6}) /;
const hashOnlyPattern = /^#{1,6}$/;

export function buildDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const { state } = view;
	const tree = syntaxTree(state);

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				const level = headingNodeNames.get(node.name);
				if (level === undefined) return;
				const line = state.doc.lineAt(node.from);

				const cursor = node.node.cursor();
				if (!cursor.firstChild()) return;

				let headerMarkFrom = -1;
				let headerMarkTo = -1;
				do {
					if (cursor.name === "HeaderMark") {
						headerMarkFrom = cursor.from;
						headerMarkTo = cursor.to;
						break;
					}
				} while (cursor.nextSibling());

				if (headerMarkFrom === -1) return;

				// Skip decoration when HeaderMark is not followed by a space.
				// lezer/markdown recognizes "#" or "##" at end of line as valid
				// ATX headings, but decoration should only apply after a space
				// is typed (e.g. "## " or "## text").
				if (
					headerMarkTo >= line.to ||
					state.doc.sliceString(headerMarkTo, headerMarkTo + 1) !== " "
				) {
					return;
				}

				builder.add(line.from, line.from, headingLineDecorations[level]);
				builder.add(headerMarkFrom, headerMarkTo + 1, replaceDecoration);
			},
		});
	}

	return builder.finish();
}

class HeadingDecorationPlugin implements PluginValue {
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

const headingDecorationPlugin = ViewPlugin.fromClass(HeadingDecorationPlugin, {
	decorations: (v) => v.decorations,
	provide: (plugin) =>
		EditorView.atomicRanges.of((view) => {
			return view.plugin(plugin)?.decorations ?? Decoration.none;
		}),
});

/**
 * Prevent the cursor from stopping at line.from of a heading line
 * (which is inside the hidden "## " marks). Instead:
 * - Left arrow from the visual start → jump to previous line end
 * - Any other navigation (Home, click, Down) → jump to after marks
 */
const headingCursorFilter = EditorState.transactionFilter.of((tr) => {
	if (!tr.selection) return tr;

	const doc = tr.newDoc;
	let modified = false;
	const oldRanges = tr.startState.selection.ranges;
	const ranges = tr.selection.ranges.map((range, i) => {
		if (!range.empty) return range;

		const pos = range.head;
		const line = doc.lineAt(pos);

		if (pos !== line.from) return range;

		const match = line.text.match(headingMarkPattern);
		if (!match) return range;

		const afterMarks = line.from + match[0].length;

		if (!tr.docChanged) {
			const oldPos = (oldRanges[i] ?? oldRanges[0]).head;
			// Leftward movement from the visual start → jump to previous line
			if (
				tr.startState.doc.lineAt(oldPos).number === line.number &&
				oldPos === afterMarks &&
				line.from > 0
			) {
				modified = true;
				return EditorSelection.cursor(line.from - 1);
			}
			// First line of the document: no previous line to jump to
			if (line.from === 0) return range;
		}

		modified = true;
		return EditorSelection.cursor(afterMarks);
	});

	if (!modified) return tr;
	return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }];
});

/**
 * Notion-like heading level override.
 * When the user types "# " (or "## ", "### ", etc.) at the visual start
 * of a heading line, the space triggers a replacement of the heading prefix.
 *
 * Example: on a "## text" line (displayed as "text" with h2 style),
 * typing "# " at the visual start transforms the document to "# text" (h1).
 */
const headingLevelOverrideHandler = EditorView.inputHandler.of((view, from, to, text) => {
	if (from !== to) return false;

	const { state } = view;
	const line = state.doc.lineAt(from);

	const existingMatch = line.text.match(headingMarkPattern);
	if (!existingMatch) return false;

	const existingMarks = existingMatch[1].length;
	const visualStart = line.from + existingMarks + 1;

	// Case 1: Space typed after # marks at visual start
	if (text === " " && from > visualStart) {
		const typed = state.doc.sliceString(visualStart, from);
		if (!hashOnlyPattern.test(typed)) return false;

		const newLevel = typed.length;
		const newPrefix = `${"#".repeat(newLevel)} `;
		view.dispatch({
			changes: { from: line.from, to: from, insert: newPrefix },
			selection: { anchor: line.from + newPrefix.length },
		});
		return true;
	}

	// Case 2: Pasted heading pattern (e.g. "# ", "## ") at visual start
	if (from === visualStart) {
		const pastedMatch = text.match(/^(#{1,6}) $/);
		if (!pastedMatch) return false;

		const newLevel = pastedMatch[1].length;
		const newPrefix = `${"#".repeat(newLevel)} `;
		view.dispatch({
			changes: { from: line.from, to: from, insert: newPrefix },
			selection: { anchor: line.from + newPrefix.length },
		});
		return true;
	}

	return false;
});

export const headingDecoration: Extension = [
	headingDecorationPlugin,
	headingCursorFilter,
	headingLevelOverrideHandler,
];
