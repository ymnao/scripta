import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * デコレーションを解除すべき行番号の集合を返す。
 * 各セレクションの **anchor 行のみ**を返す。範囲選択時に選択範囲全行を
 * 返すとドラッグ中にウィジェットデコレーションが崩壊・フリッカーするため、
 * anchor 行に限定して安定性を確保する（Issue #90）。
 *
 * エディタにフォーカスがない場合は空集合を返し、
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

/** カーソル行が指定行範囲（inclusive）に含まれるかを判定する。 */
export function cursorInRange(
	cursorLines: Set<number>,
	startLine: number,
	endLine: number,
): boolean {
	for (let l = startLine; l <= endLine; l++) {
		if (cursorLines.has(l)) return true;
	}
	return false;
}
