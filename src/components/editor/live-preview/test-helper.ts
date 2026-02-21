import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export function createTestState(
	doc: string,
	cursorPos?: number,
	extraExtensions?: Extension,
): EditorState {
	return EditorState.create({
		doc,
		extensions: [
			markdown({ base: markdownLanguage }),
			...(extraExtensions ? [extraExtensions] : []),
		],
		selection: cursorPos != null ? EditorSelection.cursor(cursorPos) : undefined,
	});
}

export function createMockView(state: EditorState): EditorView {
	ensureSyntaxTree(state, state.doc.length, 5000);
	return {
		state,
		visibleRanges: [{ from: 0, to: state.doc.length }],
	} as unknown as EditorView;
}

export function createViewForTest(doc: string, cursorPos?: number): EditorView {
	const state = createTestState(doc, cursorPos);
	return createMockView(state);
}

export function collectDecorations(
	decoSet: DecorationSet,
): { from: number; to: number; value: Decoration }[] {
	const result: { from: number; to: number; value: Decoration }[] = [];
	const cursor = decoSet.iter();
	while (cursor.value) {
		result.push({ from: cursor.from, to: cursor.to, value: cursor.value });
		cursor.next();
	}
	return result;
}

export function lineDecorations(
	decos: { from: number; to: number; value: Decoration }[],
): { from: number; to: number; value: Decoration }[] {
	return decos.filter((d) => d.from === d.to);
}

export function replaceDecorations(
	decos: { from: number; to: number; value: Decoration }[],
): { from: number; to: number; value: Decoration }[] {
	return decos.filter((d) => d.from < d.to);
}

export function widgetDecorations(
	decos: { from: number; to: number; value: Decoration }[],
): { from: number; to: number; value: Decoration }[] {
	return decos.filter((d) => (d.value.spec as { widget?: unknown }).widget != null);
}

export function markDecorations(
	decos: { from: number; to: number; value: Decoration }[],
): { from: number; to: number; value: Decoration }[] {
	return decos.filter(
		(d) =>
			d.from < d.to &&
			(d.value.spec as { class?: string }).class != null &&
			(d.value.spec as { widget?: unknown }).widget == null,
	);
}
