import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
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

const replaceDecoration = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
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

				builder.add(line.from, line.from, headingLineDecorations[level]);

				// Find HeaderMark and replace it along with the trailing space
				const cursor = node.node.cursor();
				if (cursor.firstChild()) {
					do {
						if (cursor.name === "HeaderMark") {
							let replaceEnd = cursor.to;
							// Include trailing space after the mark
							if (
								replaceEnd < line.to &&
								state.doc.sliceString(replaceEnd, replaceEnd + 1) === " "
							) {
								replaceEnd += 1;
							}
							builder.add(cursor.from, replaceEnd, replaceDecoration);
							break;
						}
					} while (cursor.nextSibling());
				}
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
		if (
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

export const headingDecoration = ViewPlugin.fromClass(HeadingDecorationPlugin, {
	decorations: (v) => v.decorations,
});
