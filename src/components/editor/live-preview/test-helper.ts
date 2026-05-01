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
	// 構築する。`ensureSyntaxTree(state, upto, timeout)` の timeout は ms ベースで
	// shuffle 並列実行下の CPU 競合では parse work loop が time-budget を使い切って
	// 部分木のまま return null するケースがある（lists / mermaid / headings 等で
	// buildDecorations が空配列になる事象が報告されている）。
	// timeout = Infinity で同期完了を強制する。markdown parser は有限 work で
	// 必ず終わるため無限ループにはならない（doc の終端で stop）。`syntaxTreeAvailable`
	// で念のため完了確認し、未完了なら追加 work を回す。
	const limit = state.doc.length;
	for (let i = 0; i < 10; i++) {
		if (syntaxTreeAvailable(state, limit)) break;
		ensureSyntaxTree(state, limit, Number.POSITIVE_INFINITY);
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
