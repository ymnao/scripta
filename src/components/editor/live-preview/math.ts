import { syntaxTree } from "@codemirror/language";
import {
	EditorSelection,
	type EditorState,
	type Extension,
	type Range,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { isEscaped } from "../../../lib/content";
import { LruCache } from "../../../lib/lru-cache";
import { collectCursorLines, cursorInRange } from "./cursor-utils";
import {
	type BlockFieldValue,
	blockFieldNeedsRebuild,
	type CandidateRange,
	cursorTouchesCandidates,
	mapCandidates,
} from "./plugin-utils";

export { isEscaped };

// ── KaTeX lazy loader ────────────────────────────────
//
// katex（本体 + CSS。CSS は 368KB のフォント base64 を含む）を初期チャンクから
// 分離するため、動的 import で遅延ロードする（#301）。mermaid.ts の
// `mermaidModule` / `initPromise` と同型のモジュールレベル loader パターンを踏襲。

let katexMod: typeof import("katex").default | null = null;
let katexLoading: Promise<void> | null = null;

/**
 * katex 本体 + CSS の動的 import を開始し、ロード完了の Promise を返す
 * （多重呼び出しでは同じ Promise を共有）。ロード完了で `katexMod` をセットし、
 * 登録済み view の再構築（notifyKatexReady）を一度だけ発火する。
 */
function ensureKatex(): Promise<void> {
	if (!katexLoading) {
		katexLoading = Promise.all([import("katex"), import("katex/dist/katex.min.css")])
			.then(([katexModule]) => {
				katexMod = katexModule.default;
				notifyKatexReady();
			})
			.catch((e: unknown) => {
				// rejected promise を抱えたままだと以後リトライ不能 + 呼び出し側
				// (toDOM の void ensureKatex()) で unhandled rejection になるため、
				// ここで握りつぶしてリセットし、次の MathWidget.toDOM で再試行させる。
				katexLoading = null;
				console.error("Failed to load katex:", e);
			});
	}
	return katexLoading;
}

/**
 * テスト用: katex の動的ロード完了を待つ。
 * lazy-load 化により `MathWidget.toDOM` が非同期になったため、同期 render を前提とした
 * 既存テストは事前にこれを await してから toDOM を呼ぶ必要がある。
 */
export function preloadKatexForTest(): Promise<void> {
	return ensureKatex();
}

// ── Render cache ──────────────────────────────────────

const MAX_CACHE_SIZE = 500;
/** key = `${displayMode}:${tex}`、value = katex.renderToString の結果 HTML。 */
const renderCache = new LruCache<string, string>(MAX_CACHE_SIZE);

function renderKatexToHtml(tex: string, displayMode: boolean): string {
	const key = `${displayMode}:${tex}`;
	const cached = renderCache.get(key);
	if (cached !== undefined) return cached;
	if (!katexMod) throw new Error("katex module is not loaded yet");
	const html = katexMod.renderToString(tex, { displayMode, throwOnError: false });
	renderCache.set(key, html);
	return html;
}

// ── View registry (katex ロード完了時の再構築先) ─────────
//
// 稼働中の EditorView をモジュールレベルの Set に登録しておき、katex ロード完了時に
// まとめて rebuildMathDecos を dispatch する。mermaid は ViewPlugin 自身が view ごとに
// render を駆動するので per-instance dispatch で足りるが、katex のロードは「数式
// widget が最初に描画された時」だけ発火させる必要があり（数式なしノートで katex を
// ロードしない、#301）、トリガー元の MathWidget.toDOM は view を参照できないため、
// 通知先をこの registry で共有するのが最小構造。

const activeMathViews = new Set<EditorView>();

/**
 * katex ロード完了時に呼ばれる。登録済み view の math decoration を再構築する。
 * ensureKatex の promise 解決経由でのみ呼ばれ、常に CM の update サイクル外で実行される
 * ため queueMicrotask による遅延は不要（mermaid.ts の同 idiom は ViewPlugin.update 内から
 * dispatch するための回避策で、ここには当てはまらない）。数式 decoration が 0 件の view は
 * placeholder が存在せず再構築不要なのでスキップする（buildMathDecorations は全文 regex
 * 走査を伴うため、数式のないタブでの無駄なフルスキャンを避ける）。
 */
function notifyKatexReady(): void {
	for (const view of activeMathViews) {
		if (view.state.field(mathDecorationField, false)?.decos.size === 0) continue;
		view.dispatch({ effects: rebuildMathDecos.of(view.hasFocus) });
	}
}

const mathViewRegistryPlugin = ViewPlugin.fromClass(
	class {
		private view: EditorView;
		constructor(view: EditorView) {
			this.view = view;
			activeMathViews.add(view);
		}
		destroy() {
			activeMathViews.delete(this.view);
		}
	},
);

// Lenient $$...$$ match (position-independent). markdown-to-html.ts の
// preprocessDisplayMath と寛容さを揃えており、Live Preview と PDF のパリティを
// 保証している (#169)。マッチ規則を変更する際は両方を同期すること。
// markdown-to-html.ts 側では、複数行 display を preprocessDisplayMath が、単一行
// display と inline を marked の inline tokenizer extension（INLINE_DISPLAY_MATH_RE /
// INLINE_MATH_RE — 下記と同形 regex の先頭アンカー版）が担当する。
const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
const INLINE_MATH_RE = /\$((?:[^\n$\\]|\\.)+)\$/g;

interface CodeRange {
	from: number;
	to: number;
}

/** Collect the document ranges occupied by FencedCode, InlineCode, and CodeBlock nodes. */
export function collectCodeRanges(
	tree: ReturnType<typeof syntaxTree>,
	from: number,
	to: number,
): CodeRange[] {
	const ranges: CodeRange[] = [];
	tree.iterate({
		from,
		to,
		enter(node) {
			if (
				node.name === "FencedCode" ||
				node.name === "InlineCode" ||
				node.name === "CodeBlock" ||
				node.name === "CodeMark" ||
				node.name === "CodeText"
			) {
				ranges.push({ from: node.from, to: node.to });
			}
		},
	});
	return ranges;
}

/**
 * ドキュメント全体の code ranges を tree 変更時のみ再計算してキャッシュする StateField。
 * math / wikilinks / link-cards からの重複呼び出し (large doc で毎回 tree 全走査していた) を
 * 単一 pass に集約する。selection / focus 変更では再計算しない。tree 同一なら doc も
 * 実質未変更なので docChanged は評価不要 (lazy parse 中に docChanged だけ立つケースの
 * 無駄計算を避ける)。
 */
export const codeRangesField = StateField.define<CodeRange[]>({
	create(state) {
		return collectCodeRanges(syntaxTree(state), 0, state.doc.length);
	},
	update(prev, tr) {
		if (syntaxTree(tr.state) === syntaxTree(tr.startState)) return prev;
		return collectCodeRanges(syntaxTree(tr.state), 0, tr.state.doc.length);
	},
});

/**
 * codeRangesField の値を取得する。production では常に extension に include されているので
 * 単なる field 読み取りだが、テストで field を include しない state でも動くよう fallback
 * を helper 側に閉じ込めた (呼び出し側に 3 重コピーがあった)。
 */
export function getCodeRanges(state: EditorState): CodeRange[] {
	return (
		state.field(codeRangesField, false) ?? collectCodeRanges(syntaxTree(state), 0, state.doc.length)
	);
}

export function overlapsCodeBlock(from: number, to: number, codeRanges: CodeRange[]): boolean {
	for (const range of codeRanges) {
		if (from < range.to && to > range.from) return true;
	}
	return false;
}

export class MathWidget extends WidgetType {
	tex: string;
	displayMode: boolean;
	/** widget 構築時点で katex がロード済みかどうか。eq に含めることで、ロード前の
	 *  placeholder widget とロード後の widget が eq=false になり、rebuildMathDecos
	 *  での再構築時に toDOM が再実行される（MermaidWidget が render 状態 svg/error を
	 *  eq に含めるのと同型、#301）。 */
	katexLoaded: boolean;
	constructor(tex: string, displayMode: boolean) {
		super();
		this.tex = tex;
		this.displayMode = displayMode;
		this.katexLoaded = katexMod !== null;
	}

	eq(other: MathWidget): boolean {
		return (
			this.tex === other.tex &&
			this.displayMode === other.displayMode &&
			this.katexLoaded === other.katexLoaded
		);
	}

	toDOM(): HTMLElement {
		const wrap = document.createElement("span");
		wrap.className = this.displayMode ? "cm-math-display" : "cm-math-inline";

		if (!katexMod) {
			// katex 未ロード: 生 TeX テキストの placeholder を出し、ロード完了を
			// mathViewRegistryPlugin 経由の rebuildMathDecos dispatch に任せる。
			wrap.classList.add("cm-math-loading");
			wrap.textContent = this.tex;
			void ensureKatex();
			return wrap;
		}

		try {
			wrap.innerHTML = renderKatexToHtml(this.tex, this.displayMode);
		} catch {
			wrap.className = "cm-math-error";
			wrap.textContent = this.tex;
		}
		return wrap;
	}

	ignoreEvent(_event: Event): boolean {
		return false;
	}
}

/** buildMathDecorations の内部実装。decoration set に加えて、StateField の差分
 *  再構築判定 (blockFieldNeedsRebuild / cursorTouchesCandidates) が使う candidate
 *  範囲 (カーソル位置フィルタ前の $ / $$ 正規表現マッチ全件) を返す。
 *  escape / code-block 判定で除外されたマッチも candidate に含める — それらが
 *  隣接編集で non-math ⇔ math に切り替わりうる以上、bail-early は安全側 (false
 *  = full rebuild) に倒すべきため。 */
function buildMathDecorationsAndCandidates(state: EditorState, hasFocus: boolean): BlockFieldValue {
	const cursorLines = collectCursorLines(state, hasFocus);
	const ranges: Range<Decoration>[] = [];
	const candidates: CandidateRange[] = [];

	const docLength = state.doc.length;
	const text = state.doc.sliceString(0, docLength);
	const codeRanges = getCodeRanges(state);
	const localDisplayRanges: CodeRange[] = [];

	// Pass 1: Display math ($$...$$). Block decoration → must be on a StateField.
	for (const match of text.matchAll(DISPLAY_MATH_RE)) {
		const matchFrom = match.index;
		const matchTo = matchFrom + match[0].length;
		candidates.push({ from: matchFrom, to: matchTo });

		if (isEscaped(text, match.index)) continue;
		const closingDisplayPos = match.index + match[0].length - 2;
		if (isEscaped(text, closingDisplayPos)) continue;
		if (overlapsCodeBlock(matchFrom, matchTo, codeRanges)) continue;

		const startLine = state.doc.lineAt(matchFrom).number;
		const endLine = state.doc.lineAt(matchTo).number;
		if (cursorInRange(cursorLines, startLine, endLine)) continue;

		const tex = match[1];
		localDisplayRanges.push({ from: matchFrom, to: matchTo });
		ranges.push(
			Decoration.replace({
				widget: new MathWidget(tex, true),
				block: true,
			}).range(matchFrom, matchTo),
		);
	}

	// Pass 2: Inline math ($...$).
	// Blank out display math and code ranges so the regex does not consume $ from those regions.
	let textForInline = text;
	if (localDisplayRanges.length > 0 || codeRanges.length > 0) {
		const allRanges = [...localDisplayRanges, ...codeRanges]
			.filter((r) => r.from < r.to)
			.sort((a, b) => a.from - b.from);
		const parts: string[] = [];
		let pos = 0;
		for (const r of allRanges) {
			if (r.from > pos) parts.push(text.slice(pos, r.from));
			const blankLen = r.to - Math.max(r.from, pos);
			if (blankLen > 0) parts.push(" ".repeat(blankLen));
			pos = Math.max(pos, r.to);
		}
		if (pos < text.length) parts.push(text.slice(pos));
		textForInline = parts.join("");
	}

	for (const match of textForInline.matchAll(INLINE_MATH_RE)) {
		const matchFrom = match.index;
		const matchTo = matchFrom + match[0].length;
		candidates.push({ from: matchFrom, to: matchTo });

		if (isEscaped(textForInline, match.index)) continue;
		const closingInlinePos = match.index + match[0].length - 1;
		if (isEscaped(textForInline, closingInlinePos)) continue;

		// Ensure the match does not span across blanked-out code/display regions
		if (overlapsCodeBlock(matchFrom, matchTo, codeRanges)) continue;
		if (localDisplayRanges.some((dr) => !(matchTo <= dr.from || matchFrom >= dr.to))) continue;

		const lineNum = state.doc.lineAt(matchFrom).number;
		if (cursorLines.has(lineNum)) continue;

		const tex = match[1];
		ranges.push(
			Decoration.replace({
				widget: new MathWidget(tex, false),
			}).range(matchFrom, matchTo),
		);
	}

	return { decos: Decoration.set(ranges, true), candidates };
}

/** 公開 API: DecorationSet のみを返す (既存の呼び出し元 / テスト向けの後方互換ラッパー)。 */
export function buildMathDecorations(state: EditorState, hasFocus: boolean): DecorationSet {
	return buildMathDecorationsAndCandidates(state, hasFocus).decos;
}

const rebuildMathDecos = StateEffect.define<boolean>();

const mathHasFocusField = StateField.define<boolean>({
	create() {
		return false;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(rebuildMathDecos)) return e.value;
		}
		return value;
	},
});

/** math candidate 判定の marker 文字。挿入/削除テキストに `$` が含まれれば
 *  新規候補の出現/消滅の可能性があるため full rebuild にフォールバックする。 */
// non-global にすることで `.test()` が stateless になり、呼び出しをまたいだ
// lastIndex 状態漏れ (false negative = rebuild 漏れ) が構造的に発生しなくなる。
const MATH_MARKER_RE = /\$/;

/** テスト用に export。StateField 自体を state.field() で直接読むことで、
 *  update() の rebuild / skip 判定を EditorView / 実 focus イベントなしに検証できる
 *  （math.test.ts 参照）。 */
export const mathDecorationField = StateField.define<BlockFieldValue>({
	create(state) {
		return buildMathDecorationsAndCandidates(state, false);
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(rebuildMathDecos)) {
				return buildMathDecorationsAndCandidates(tr.state, e.value);
			}
		}
		if (tr.docChanged) {
			if (blockFieldNeedsRebuild(tr, value.candidates, MATH_MARKER_RE)) {
				return buildMathDecorationsAndCandidates(tr.state, tr.state.field(mathHasFocusField));
			}
			return {
				decos: value.decos.map(tr.changes),
				candidates: mapCandidates(value.candidates, tr.changes),
			};
		}
		if (tr.selection && cursorTouchesCandidates(tr, value.candidates)) {
			return buildMathDecorationsAndCandidates(tr.state, tr.state.field(mathHasFocusField));
		}
		return value;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

const mathFocusHandler = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (update.focusChanged) {
				const { view } = update;
				queueMicrotask(() => {
					view.dispatch({ effects: rebuildMathDecos.of(view.hasFocus) });
				});
			}
		}
	},
);

/**
 * Click handler for math widgets. Returns true to suppress the editor's
 * default range-selection behaviour. ignoreEvent()=>false on the widget
 * lets the editor place the cursor normally if this handler does not match.
 */
function createMathClickHandler() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, view: EditorView) {
			const target = event.target as HTMLElement;
			const mathEl = target.closest(".cm-math-inline, .cm-math-display");
			if (!mathEl) return false;

			const fieldValue = view.state.field(mathDecorationField, false);
			if (!fieldValue) return false;

			const pos = view.posAtDOM(mathEl);
			let endPos = -1;

			const iter = fieldValue.decos.iter();
			while (iter.value) {
				if (iter.from <= pos && pos <= iter.to) {
					endPos = iter.to;
					break;
				}
				if (iter.from > pos) break;
				iter.next();
			}

			if (endPos === -1) return false;

			event.preventDefault();
			view.dispatch({ selection: EditorSelection.cursor(endPos) });
			view.focus();
			return true;
		},
	});
}

/**
 * Auto-close `$` like brackets/quotes:
 * - Typing `$` inserts `$$` with cursor between
 * - Typing `$` when next char is `$` skips over it
 */
const dollarInputHandler = EditorView.inputHandler.of((view, _from, _to, insert) => {
	if (insert !== "$") return false;

	const { state } = view;

	const changes = state.changeByRange((range) => {
		const pos = range.from;
		const nextChar = state.doc.sliceString(pos, pos + 1);

		// Skip-over: if cursor is right before a `$`, just move past it
		if (range.empty && nextChar === "$") {
			return {
				range: EditorSelection.cursor(pos + 1),
				changes: { from: pos, to: pos, insert: "" },
			};
		}

		// Selection wrapping: wrap selected text in $...$
		if (!range.empty) {
			return {
				range: EditorSelection.cursor(range.to + 2),
				changes: [
					{ from: range.from, insert: "$" },
					{ from: range.to, insert: "$" },
				],
			};
		}

		// Auto-close: insert $$ with cursor between
		return {
			range: EditorSelection.cursor(range.from + 1),
			changes: { from: range.from, to: range.to, insert: "$$" },
		};
	});

	view.dispatch(changes, { scrollIntoView: true, userEvent: "input" });
	return true;
});

/** Backspace between empty `$$` deletes both. */
const dollarBackspace = keymap.of([
	{
		key: "Backspace",
		run(view) {
			const { state } = view;
			for (const range of state.selection.ranges) {
				if (!range.empty) return false;
				const pos = range.from;
				if (pos === 0 || pos >= state.doc.length) return false;
				const before = state.doc.sliceString(pos - 1, pos);
				const after = state.doc.sliceString(pos, pos + 1);
				if (before !== "$" || after !== "$") return false;
			}

			view.dispatch(
				state.changeByRange((range) => ({
					range: EditorSelection.cursor(range.from - 1),
					changes: { from: range.from - 1, to: range.from + 1 },
				})),
				{ scrollIntoView: true, userEvent: "delete" },
			);
			return true;
		},
	},
]);

export const mathDecoration: Extension = [
	codeRangesField,
	mathHasFocusField,
	mathDecorationField,
	mathFocusHandler,
	mathViewRegistryPlugin,
	createMathClickHandler(),
	dollarInputHandler,
	dollarBackspace,
];
