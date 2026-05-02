import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export function createTestState(
	doc: string,
	cursorPos?: number,
	extraExtensions?: Extension,
	selection?: EditorSelection,
): EditorState {
	const initial = EditorState.create({
		doc,
		extensions: [
			markdown({ base: markdownLanguage }),
			...(extraExtensions ? [extraExtensions] : []),
		],
		selection: selection ?? (cursorPos != null ? EditorSelection.cursor(cursorPos) : undefined),
	});
	// LanguageState.init は viewport 3000 文字までしか parse せず、その先は lazy。
	// テストでは `syntaxTree(state)` の完全な tree が必要なので、ここで全文 parse する。
	ensureSyntaxTree(initial, initial.doc.length, Number.POSITIVE_INFINITY);
	// `ensureSyntaxTree` は parse context の tree を更新するが、`syntaxTree(state)` が
	// 返す `field.tree` はスナップショットなので同期されない。
	// LanguageState.apply は `this.tree != this.context.tree` のとき new LanguageState を
	// 作って context.tree を field.tree にコピーする。no-op transaction で apply を
	// 発火させ、field.tree を最新の parse 結果と同期する。
	return initial.update({}).state;
}

export function createMockView(
	state: EditorState,
	visibleRanges?: { from: number; to: number }[],
	hasFocus = false,
): EditorView {
	return {
		state,
		visibleRanges: visibleRanges ?? [{ from: 0, to: state.doc.length }],
		hasFocus,
	} as unknown as EditorView;
}

export function createViewForTest(
	doc: string,
	cursorPos?: number,
	visibleRanges?: { from: number; to: number }[],
	hasFocus?: boolean,
	selection?: EditorSelection,
): EditorView {
	const state = createTestState(doc, cursorPos, undefined, selection);
	return createMockView(state, visibleRanges, hasFocus ?? (selection != null || cursorPos != null));
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
