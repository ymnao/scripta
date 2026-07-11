import { syntaxTree } from "@codemirror/language";
import type { ChangeDesc, Transaction } from "@codemirror/state";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";

/** 「カーソル位置フィルタ前」の全マッチ範囲 (candidate)。 */
export interface CandidateRange {
	from: number;
	to: number;
}

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
 * enter が false を返せば tree.iterate 側で子ノード走査を抑制する仕様は維持される。
 * 第 2 引数 `ctx` は visible range 情報を持つが、**enter 呼び出し中のみ有効** — helper
 * 側で 1 個の object を hoist して from/to を per-range に書き換えているため、caller が
 * 保持して後で読むと壊れる。
 */
export function iterateVisibleSyntax(
	view: EditorView,
	enter: (node: SyntaxNodeRefLike, ctx: VisibleSyntaxContext) => boolean | undefined,
): void {
	const tree = syntaxTree(view.state);
	const ctx: VisibleSyntaxContext = { tree, from: 0, to: 0 };
	for (const { from, to } of view.visibleRanges) {
		ctx.from = from;
		ctx.to = to;
		tree.iterate({ from, to, enter: (node) => enter(node, ctx) });
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

/**
 * blockFieldNeedsRebuild: docChanged 時に full rebuild が必要か判定する。
 * ① 挿入/削除テキストが marker 文字を含むなら true (新規候補の出現/消滅を検知)
 *    - 挿入: iterChanges の `inserted` を文字列化
 *    - 削除: `tr.startState.sliceDoc(fromA, toA)` (削除範囲の旧テキスト)
 * ② 変更範囲 (fromB..toB を旧座標 fromA..toA) が candidates と交差 or ±1 行 隣接するなら true
 *    - candidates は tr.changes.mapPos で新座標へ写像してから比較
 *    - テーブル/fence は行構造なので行 pad が安全 (issue の設計通り)
 * どちらも false なら false = decos.map + candidates map で済む。
 */
export function blockFieldNeedsRebuild(
	tr: Transaction,
	candidates: readonly CandidateRange[],
	markerRe: RegExp,
): boolean {
	if (!tr.docChanged) return false;
	let needsRebuild = false;
	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (needsRebuild) return;
		// ① marker 文字判定。global regex は呼び出しをまたいで lastIndex が
		// 残る可能性があるので `.test()` 前に必ず reset (前回 true で早期 return した
		// 場合の残留対策も含む)。
		const insertedText = inserted.toString();
		markerRe.lastIndex = 0;
		if (markerRe.test(insertedText)) {
			needsRebuild = true;
			return;
		}
		const deletedText = fromA < toA ? tr.startState.doc.sliceString(fromA, toA) : "";
		if (deletedText) {
			markerRe.lastIndex = 0;
			if (markerRe.test(deletedText)) {
				needsRebuild = true;
				return;
			}
		}
		markerRe.lastIndex = 0;
		// ② 変更範囲と candidates の交差 / ±1 行 隣接
		// candidates を新座標へ写像
		for (const c of candidates) {
			const mappedFrom = tr.changes.mapPos(c.from, -1);
			const mappedTo = tr.changes.mapPos(c.to, 1);
			// 変更範囲 (新座標での fromB..toB) と mapped candidate の交差
			const changeFromB = tr.changes.mapPos(fromA, -1);
			const changeToB = tr.changes.mapPos(toA, 1);
			// ±1 行 pad: 変更前後の行を含めて比較 (issue の設計、テーブル/fence の marker 行対策で
			// math も同型)
			const newDoc = tr.state.doc;
			const padFromLine = Math.max(
				1,
				newDoc.lineAt(Math.min(changeFromB, newDoc.length)).number - 1,
			);
			const padToLine = Math.min(
				newDoc.lines,
				newDoc.lineAt(Math.min(changeToB, newDoc.length)).number + 1,
			);
			const padFrom = newDoc.line(padFromLine).from;
			const padTo = newDoc.line(padToLine).to;
			if (mappedFrom < padTo && mappedTo > padFrom) {
				needsRebuild = true;
				return;
			}
		}
	});
	return needsRebuild;
}

/**
 * cursorTouchesCandidates: selection 変化時、旧/新カーソル行が candidates と交差するときのみ true。
 * 現状の cursorLinesChanged 比較 (行が変わる度全再構築) を置換する。
 */
export function cursorTouchesCandidates(
	tr: Transaction,
	candidates: readonly CandidateRange[],
): boolean {
	if (!tr.selection) return false;
	// 旧カーソル位置 (startState.selection) と新カーソル位置の行番号を集計
	const oldSel = tr.startState.selection;
	const newSel = tr.state.selection;
	const oldDoc = tr.startState.doc;
	const newDoc = tr.state.doc;
	const oldLines = new Set<number>();
	const newLines = new Set<number>();
	for (const r of oldSel.ranges) {
		oldLines.add(oldDoc.lineAt(Math.min(r.head, oldDoc.length)).number);
	}
	for (const r of newSel.ranges) {
		newLines.add(newDoc.lineAt(Math.min(r.head, newDoc.length)).number);
	}
	// candidates の行を旧/新座標で判定
	for (const c of candidates) {
		// 旧座標での candidate の行範囲
		const oldFromLine = oldDoc.lineAt(Math.min(c.from, oldDoc.length)).number;
		const oldToLine = oldDoc.lineAt(Math.min(c.to, oldDoc.length)).number;
		for (let ln = oldFromLine; ln <= oldToLine; ln++) {
			if (oldLines.has(ln)) return true;
		}
		// 新座標では tr.changes.mapPos で写像 (candidates はまだ update() で map してない前提)
		const newFrom = tr.changes.mapPos(c.from, -1);
		const newTo = tr.changes.mapPos(c.to, 1);
		const newFromLine = newDoc.lineAt(Math.min(newFrom, newDoc.length)).number;
		const newToLine = newDoc.lineAt(Math.min(newTo, newDoc.length)).number;
		for (let ln = newFromLine; ln <= newToLine; ln++) {
			if (newLines.has(ln)) return true;
		}
	}
	return false;
}

/**
 * candidates を Transaction の changes で新座標へ写像するヘルパー。
 * from/to が退化 (from >= to) するものは除外。
 */
export function mapCandidates(
	candidates: readonly CandidateRange[],
	changes: ChangeDesc,
): CandidateRange[] {
	const out: CandidateRange[] = [];
	for (const c of candidates) {
		const from = changes.mapPos(c.from, -1);
		const to = changes.mapPos(c.to, 1);
		if (from < to) out.push({ from, to });
	}
	return out;
}
