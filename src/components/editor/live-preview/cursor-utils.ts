import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * カーソルが存在する行番号の集合を返す。
 * エディタにフォーカスがない場合（ファイルを開いた直後など）は空集合を返し、
 * 全行のデコレーションが適用されるようにする。
 *
 * EditorView を渡す場合は view.hasFocus を自動で参照する。
 * EditorState + hasFocus を渡す場合は明示的にフォーカス状態を指定する。
 */
export function collectCursorLines(view: EditorView): Set<number>;
export function collectCursorLines(state: EditorState, hasFocus: boolean): Set<number>;
export function collectCursorLines(
	viewOrState: EditorView | EditorState,
	hasFocus?: boolean,
): Set<number> {
	const lines = new Set<number>();
	const state = "state" in viewOrState ? viewOrState.state : viewOrState;
	const focused = hasFocus ?? ("hasFocus" in viewOrState ? viewOrState.hasFocus : false);
	if (!focused) return lines;
	for (const range of state.selection.ranges) {
		lines.add(state.doc.lineAt(range.anchor).number);
	}
	return lines;
}
