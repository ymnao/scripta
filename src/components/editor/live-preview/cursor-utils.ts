import type { EditorView } from "@codemirror/view";

/**
 * カーソルが存在する行番号の集合を返す。
 * エディタにフォーカスがない場合（ファイルを開いた直後など）は空集合を返し、
 * 全行のデコレーションが適用されるようにする。
 */
export function collectCursorLines(view: EditorView): Set<number> {
	const lines = new Set<number>();
	if (!view.hasFocus) return lines;
	const { state } = view;
	for (const range of state.selection.ranges) {
		const fromLine = state.doc.lineAt(range.from).number;
		const toLine = state.doc.lineAt(range.to).number;
		for (let l = fromLine; l <= toLine; l++) {
			lines.add(l);
		}
	}
	return lines;
}
