import { syntaxTree } from "@codemirror/language";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";

type IterateSpec = Parameters<ReturnType<typeof syntaxTree>["iterate"]>[0];
type IterateEnter = NonNullable<IterateSpec["enter"]>;
type SyntaxNodeRefLike = Parameters<IterateEnter>[0];

/** iterateVisibleSyntax の enter callback に渡される visible range 情報。 */
export type VisibleSyntaxContext = {
	tree: ReturnType<typeof syntaxTree>;
	from: number;
	to: number;
};

/**
 * ビューの visibleRanges 全体で syntax tree を iterate し、enter callback を呼ぶ。
 * live-preview のパターン A 9 デコレーションで共通の
 * `for-of (visibleRanges) → tree.iterate({from, to, enter})` を集約する。
 *
 * enter callback には第 2 引数として visible range 情報を渡す。tree/from/to のいずれかを
 * 内部で使わない呼び出しは第 2 引数を無視すればよい (JS の可変長引数)。enter が false を
 * 返せば tree.iterate 側で子ノード走査を抑制する仕様は維持される。
 */
export function iterateVisibleSyntax(
	view: EditorView,
	enter: (node: SyntaxNodeRefLike, ctx: VisibleSyntaxContext) => boolean | undefined,
): void {
	const tree = syntaxTree(view.state);
	for (const { from, to } of view.visibleRanges) {
		tree.iterate({ from, to, enter: (node) => enter(node, { tree, from, to }) });
	}
}

/**
 * ViewUpdate が IME composing 中なら decorations を changes で map しておき、
 * 再構築を skip したいことを伝える。呼び出し側は戻り値 true で早期 return する。
 * `atomicRanges` 等の追加 DecorationSet を持つ plugin (lists.ts) では、
 * 対応する property を target に含めればそちらも同じ changes で map される。
 *
 * ```ts
 * update(update: ViewUpdate) {
 *   if (handleComposingUpdate(update, this)) return;
 *   ...
 * }
 * ```
 */
export function handleComposingUpdate(
	update: ViewUpdate,
	target: { decorations: DecorationSet; atomicRanges?: DecorationSet },
): boolean {
	if (!update.view.composing) return false;
	if (update.docChanged) {
		target.decorations = target.decorations.map(update.changes);
		if (target.atomicRanges !== undefined) {
			target.atomicRanges = target.atomicRanges.map(update.changes);
		}
	}
	return true;
}
