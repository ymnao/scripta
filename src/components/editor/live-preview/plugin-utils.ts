import { syntaxTree } from "@codemirror/language";
import {
	type ChangeDesc,
	type Extension,
	type Range,
	StateEffect,
	type Transaction,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	type WidgetType,
} from "@codemirror/view";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";

/** 「カーソル位置フィルタ前」の全マッチ範囲 (candidate)。 */
export interface CandidateRange {
	from: number;
	to: number;
}

/** math / mermaid / table の StateField 値の共通形。
 *  `decos` は field が provide する DecorationSet、`candidates` は差分再構築判定
 *  (`blockFieldNeedsRebuild` / `cursorTouchesCandidates`) が参照するカーソル位置
 *  フィルタ前の全マッチ範囲。3 field で同一形状のため中央に集約している。 */
export interface BlockFieldValue {
	decos: DecorationSet;
	candidates: CandidateRange[];
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
 * 挿入/削除テキストが marker 文字を含むかどうか (`.test()` のみで消費、副作用なし)。
 * 呼び出し側は non-global regex (`/\$/` 等) を渡すこと — global (`/g`) では
 * `.test()` が lastIndex を更新し呼び出しをまたいで状態が漏れる。stateless に
 * することで前バージョンの `markerRe.lastIndex = 0` reset パターンが不要になる。
 */
function changedTextContainsMarker(tr: Transaction, markerRe: RegExp): boolean {
	let hit = false;
	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		if (hit) return;
		if (markerRe.test(inserted.toString())) {
			hit = true;
			return;
		}
		if (fromA < toA) {
			const deletedText = tr.startState.doc.sliceString(fromA, toA);
			if (markerRe.test(deletedText)) hit = true;
		}
	});
	return hit;
}

/**
 * 変更範囲 (新座標) が candidates と交差 or ±1 行 隣接するかどうか。
 * ±1 行 pad は table/fence の marker 行対策 (issue #303 の設計方針)。
 * candidates は tr.changes.mapPos で新座標へ写像してから比較する。
 */
function changedRangeTouchesCandidates(
	tr: Transaction,
	candidates: readonly CandidateRange[],
): boolean {
	const newDoc = tr.state.doc;
	// candidates を新座標へ 1 回だけ写像 (iterChanges の外で hoist)。
	const mapped: CandidateRange[] = [];
	for (const c of candidates) {
		mapped.push({
			from: tr.changes.mapPos(c.from, -1),
			to: tr.changes.mapPos(c.to, 1),
		});
	}
	let hit = false;
	tr.changes.iterChanges((_fromA, _toA, fromB, toB, _inserted) => {
		if (hit) return;
		// ±1 行 pad は変更範囲側で 1 回計算 (candidate ごとに再計算しない)。
		const padFromLine = Math.max(1, newDoc.lineAt(Math.min(fromB, newDoc.length)).number - 1);
		const padToLine = Math.min(
			newDoc.lines,
			newDoc.lineAt(Math.min(toB, newDoc.length)).number + 1,
		);
		const padFrom = newDoc.line(padFromLine).from;
		const padTo = newDoc.line(padToLine).to;
		for (const m of mapped) {
			if (m.from < padTo && m.to > padFrom) {
				hit = true;
				return;
			}
		}
	});
	return hit;
}

/**
 * blockFieldNeedsRebuild: docChanged 時に full rebuild が必要か判定する。
 * ① 挿入/削除テキストが marker 文字を含むなら true (新規候補の出現/消滅を検知)
 * ② 変更範囲 (新座標) が candidates と交差 or ±1 行 隣接するなら true
 * どちらも false なら false = decos.map + candidates map で済む。
 */
export function blockFieldNeedsRebuild(
	tr: Transaction,
	candidates: readonly CandidateRange[],
	markerRe: RegExp,
): boolean {
	if (!tr.docChanged) return false;
	return changedTextContainsMarker(tr, markerRe) || changedRangeTouchesCandidates(tr, candidates);
}

/**
 * cursorTouchesCandidates: selection 変化時、カーソル行が candidates と交差するときのみ true。
 * 現状の cursorLinesChanged 比較 (行が変わる度全再構築) を置換する。
 * 呼び出し規約: docChanged=false の transaction 限定 (呼び出し側で
 * `if (tr.docChanged) ... return; if (tr.selection && cursorTouchesCandidates(tr, ...))` の形)。
 * この規約下では tr.changes は恒等写像なので candidates を写像する必要はない。
 */
export function cursorTouchesCandidates(
	tr: Transaction,
	candidates: readonly CandidateRange[],
): boolean {
	if (!tr.selection) return false;
	// 旧カーソル位置 (startState.selection) と新カーソル位置の行番号を集計。
	// docChanged=false 前提なので oldDoc === newDoc、oldLines/newLines を同じ doc で集める。
	// **anchor のみ** を見る (head ではない)。widget 表示可否を決める collectCursorLines
	// も anchor のみを参照する仕様 (Issue #90 のドラッグ時ちらつき防止) なので、rebuild
	// トリガもそちらに揃える必要がある。head を混ぜると、anchor が block 外・head が
	// block 内のドラッグ選択で「見た目は不変なのに毎ステップ full rebuild」が起きる。
	const doc = tr.state.doc;
	const cursorLines = new Set<number>();
	for (const r of tr.startState.selection.ranges) {
		cursorLines.add(doc.lineAt(Math.min(r.anchor, doc.length)).number);
	}
	for (const r of tr.state.selection.ranges) {
		cursorLines.add(doc.lineAt(Math.min(r.anchor, doc.length)).number);
	}
	for (const c of candidates) {
		const fromLine = doc.lineAt(Math.min(c.from, doc.length)).number;
		const toLine = doc.lineAt(Math.min(c.to, doc.length)).number;
		if (cursorInRange(cursorLines, fromLine, toLine)) return true;
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

// 共通 tree-change effect。
// mermaid / table の StateField はいずれも syntax tree に依存し、CM の lazy parse が
// 進行するたびに再構築が必要。従来は mermaid.ts と table-decoration.ts に同一実装の
// treeChangeDetector が別々に存在し、tree 差し替え毎に **別 transaction で 2 回 dispatch**
// していた。これを 1 transaction にまとめてカスケードを半減させる。
export const treeParseProgressed = StateEffect.define<null>();

/**
 * `HorizontalRule` ノード (`---` / `***` / `___`) を `widgetFactory()` の widget で
 * replace する ViewPlugin を生成する。カーソルがある行では replace を抑制し
 * (raw マーカーを残す)、docChanged / viewportChanged / syntax tree 差し替え時に
 * 全再構築、selection / focus 変化はカーソル行集合の変化があった場合のみ再構築する。
 *
 * horizontal-rules.ts と slide-separators.ts の共通実装。tests から
 * buildDecorations を呼ぶユースケース (widget 数の snapshot 検証) のため、
 * extension だけでなく buildDecorations も返す。
 */
export function createHrReplaceDecoration(widgetFactory: () => WidgetType): {
	buildDecorations: (view: EditorView) => DecorationSet;
	extension: Extension;
} {
	const buildDecorations = (view: EditorView): DecorationSet => {
		const { state } = view;
		const cursorLines = collectCursorLines(view);
		const ranges: Range<Decoration>[] = [];
		iterateVisibleSyntax(view, (node) => {
			if (node.name !== "HorizontalRule") return;
			if (cursorLines.size > 0) {
				const lineNumber = state.doc.lineAt(node.from).number;
				if (cursorLines.has(lineNumber)) return;
			}
			ranges.push(Decoration.replace({ widget: widgetFactory() }).range(node.from, node.to));
		});
		return Decoration.set(ranges, true);
	};

	class HrReplacePlugin implements PluginValue {
		decorations: DecorationSet;
		prevCursorLines: Set<number>;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view);
			this.prevCursorLines = collectCursorLines(view);
		}

		update(update: ViewUpdate) {
			if (handleComposingUpdate(update, this)) return;
			const forceRebuild =
				update.docChanged ||
				update.viewportChanged ||
				syntaxTree(update.state) !== syntaxTree(update.startState);
			if (forceRebuild) {
				this.decorations = buildDecorations(update.view);
				this.prevCursorLines = collectCursorLines(update.view);
			} else if (update.selectionSet || update.focusChanged) {
				const next = collectCursorLines(update.view);
				if (cursorLinesChanged(this.prevCursorLines, next)) {
					this.prevCursorLines = next;
					this.decorations = buildDecorations(update.view);
				}
			}
		}
	}

	const extension = ViewPlugin.fromClass(HrReplacePlugin, {
		decorations: (v) => v.decorations,
	});

	return { buildDecorations, extension };
}

export const treeChangeDispatcher = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (!update.docChanged && syntaxTree(update.state) !== syntaxTree(update.startState)) {
				const { view } = update;
				queueMicrotask(() => {
					view.dispatch({ effects: treeParseProgressed.of(null) });
				});
			}
		}
	},
);
