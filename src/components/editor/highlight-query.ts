import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

export const setHighlightQuery = StateEffect.define<string>();

const highlightQueryField = StateField.define<string>({
	create: () => "",
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHighlightQuery)) return effect.value;
		}
		if (tr.docChanged) return "";
		return value;
	},
});

const highlightMark = Decoration.mark({ class: "cm-searchMatch" });

const highlightPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(update: ViewUpdate) {
			const queryChanged =
				update.state.field(highlightQueryField) !== update.startState.field(highlightQueryField);
			if (queryChanged || update.docChanged || update.viewportChanged) {
				this.decorations = this.build(update.view);
			}
		}

		build(view: EditorView): DecorationSet {
			const query = view.state.field(highlightQueryField);
			if (!query) return Decoration.none;

			const builder = new RangeSetBuilder<Decoration>();
			const lowerQuery = query.toLowerCase();

			for (const { from, to } of view.visibleRanges) {
				const text = view.state.sliceDoc(from, to);
				const lowerText = text.toLowerCase();
				let pos = 0;
				while (pos < lowerText.length) {
					const idx = lowerText.indexOf(lowerQuery, pos);
					if (idx === -1) break;
					builder.add(from + idx, from + idx + lowerQuery.length, highlightMark);
					pos = idx + 1;
				}
			}

			return builder.finish();
		}
	},
	{ decorations: (v) => v.decorations },
);

export const highlightQueryExtension = [highlightQueryField, highlightPlugin];
