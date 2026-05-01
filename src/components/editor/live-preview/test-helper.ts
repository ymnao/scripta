import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export function createTestState(
	doc: string,
	cursorPos?: number,
	extraExtensions?: Extension,
	selection?: EditorSelection,
): EditorState {
	const state = EditorState.create({
		doc,
		extensions: [
			markdown({ base: markdownLanguage }),
			...(extraExtensions ? [extraExtensions] : []),
		],
		selection: selection ?? (cursorPos != null ? EditorSelection.cursor(cursorPos) : undefined),
	});
	// `syntaxTree(state)` を直接呼ぶテストが多いため、ここで構文木を完全に
	// 構築する。`ensureSyntaxTree` の timeout は ms ベースで shuffle 並列実行下では
	// CPU 競合により 5 秒以内に完了しないことがある。`syntaxTreeAvailable` で
	// 完了確認しつつ十分長い timeout で poll する（markdown の小さな doc なら
	// 通常 1〜2 ループで終わる。100 ループ × 60 秒で実質無制限）。
	const limit = state.doc.length;
	for (let i = 0; i < 100; i++) {
		if (syntaxTreeAvailable(state, limit)) break;
		ensureSyntaxTree(state, limit, 60_000);
	}
	return state;
}

export function createMockView(
	state: EditorState,
	visibleRanges?: { from: number; to: number }[],
	hasFocus = false,
): EditorView {
	ensureSyntaxTree(state, state.doc.length, 5000);
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
