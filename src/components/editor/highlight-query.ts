import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";

export const setHighlightQuery = StateEffect.define<string>();

/** ASCII 文字のみで構成されるかを判定する。 */
function isAsciiOnly(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 127) return false;
	}
	return true;
}

/**
 * Build a mapping from UTF-16 code unit offsets in the lowercased string
 * back to the corresponding UTF-16 code unit offsets in the original string.
 * `toLowerCase()` can change string length (e.g. İ → i̇), so we need
 * to map indices found in the lowered string back to their original positions.
 */
function buildLowerToOrigUtf16Map(text: string): number[] | null {
	if (isAsciiOnly(text)) return null;
	const map: number[] = [];
	let origOffset = 0;
	for (const ch of text) {
		const origLen = ch.length;
		const lowerLen = ch.toLowerCase().length;
		for (let i = 0; i < lowerLen; i++) {
			map.push(origOffset);
		}
		origOffset += origLen;
	}
	map.push(origOffset);
	return map;
}

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
			if (update.view.composing) {
				if (update.docChanged) this.decorations = this.decorations.map(update.changes);
				return;
			}
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
				const lowerToOrig = buildLowerToOrigUtf16Map(text);
				let pos = 0;
				while (pos < lowerText.length) {
					const idx = lowerText.indexOf(lowerQuery, pos);
					if (idx === -1) break;
					const origStart = lowerToOrig ? lowerToOrig[idx] : idx;
					const origEnd = lowerToOrig
						? lowerToOrig[idx + lowerQuery.length]
						: idx + lowerQuery.length;
					builder.add(from + origStart, from + origEnd, highlightMark);
					pos = idx + 1;
				}
			}

			return builder.finish();
		}
	},
	{ decorations: (v) => v.decorations },
);

export const highlightQueryExtension = [highlightQueryField, highlightPlugin];
