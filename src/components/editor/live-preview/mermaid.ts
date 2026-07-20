import { syntaxTree } from "@codemirror/language";
import {
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
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import {
	clearMermaidCache,
	getCacheEntry,
	isMermaidInitFailureExhausted,
	renderMermaid,
	shouldSkipMermaidInitRetry,
} from "../../../lib/mermaid";
import { useSettingsStore } from "../../../stores/settings";
import { useThemeStore } from "../../../stores/theme";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";
import {
	type BlockFieldValue,
	blockFieldNeedsRebuild,
	type CandidateRange,
	cursorTouchesCandidates,
	mapCandidates,
	treeChangeDispatcher,
	treeParseProgressed,
} from "./plugin-utils";

// ── Effects ───────────────────────────────────────────

/** hasFocus の実値を運ぶ Effect。推定ではなく view.hasFocus を渡す。 */
const rebuildMermaidDecos = StateEffect.define<boolean>();

/** エディタのフォーカス状態を追跡する StateField。
 *  docChanged/selectionSet 時に推定ではなく実フォーカス値を参照するために使用。 */
const hasFocusField = StateField.define<boolean>({
	create() {
		return false;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(rebuildMermaidDecos)) return e.value;
		}
		return value;
	},
});

// ── Types ─────────────────────────────────────────────

interface MermaidBlock {
	from: number;
	to: number;
	source: string;
}

// ── Init-failure UI wiring (issue #363 / #384) ────────
//
// init 失敗の back-off・cap 判定・reset は `src/lib/mermaid.ts` に集約されている
// (グローバル 1 record + burst collapse + `cacheGeneration` guard)。ここでは:
//  - `shouldSkipMermaidInitRetry` で fresh render 起動の gate
//  - `isMermaidInitFailureExhausted` で cap 到達時の error 表示切り替え
// のみ利用する。theme/font 変更時の record reset は `clearMermaidCache` が内包する。
export const INIT_FAILURE_MESSAGE = "Mermaid の読み込みに失敗しました (編集すると再試行します)";

// ── Helpers ───────────────────────────────────────────

/** Find mermaid fenced code blocks in the document.
 *  Optional `range` limits tree iteration to the given span. */
export function findMermaidBlocks(
	state: EditorState,
	range?: { from: number; to: number },
): MermaidBlock[] {
	const tree = syntaxTree(state);
	const blocks: MermaidBlock[] = [];

	tree.iterate({
		from: range?.from,
		to: range?.to,
		enter(node) {
			if (node.name !== "FencedCode") return;

			const startLine = state.doc.lineAt(node.from);
			const fenceText = startLine.text.trim();

			// Check if this is a mermaid block
			if (!/^`{3,}\s*mermaid\s*$/.test(fenceText)) return;

			const endLine = state.doc.lineAt(node.to);

			// Extract source (lines between opening and closing fence)
			const lines: string[] = [];
			for (let l = startLine.number + 1; l < endLine.number; l++) {
				lines.push(state.doc.line(l).text);
			}
			const source = lines.join("\n").trim();
			if (!source) return;

			blocks.push({
				from: node.from,
				to: node.to,
				source,
			});
		},
	});

	return blocks;
}

// ── Widget ────────────────────────────────────────────

export class MermaidWidget extends WidgetType {
	source: string;
	svg: string | null;
	error: string | null;
	constructor(source: string, svg: string | null, error: string | null) {
		super();
		this.source = source;
		this.svg = svg;
		this.error = error;
	}

	eq(other: MermaidWidget): boolean {
		return this.source === other.source && this.svg === other.svg && this.error === other.error;
	}

	toDOM(): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = "cm-mermaid-widget";

		if (this.svg) {
			const inner = document.createElement("div");
			inner.className = "cm-mermaid-inner";
			inner.innerHTML = this.svg;
			const svgEl = inner.querySelector("svg");
			if (svgEl) {
				// Mermaid v11 が emit する自然サイズ（width="100%" + style="max-width: Xpx"）を
				// そのまま尊重する。以前は max-width を 1.35x に上書きして人工的に拡大して
				// いたが、mermaid v11 の自然サイズと組み合わさり「でかすぎる」UX になって
				// いたため撤去した（ベストプラクティス: artificial scale up しない）。
				// SVG は viewBox + width="100%" でアスペクト比を保持しコンテナ幅に合わせる。
				svgEl.setAttribute("width", "100%");
				svgEl.removeAttribute("height");
			}
			wrapper.appendChild(inner);
		} else if (this.error) {
			const errorEl = document.createElement("div");
			errorEl.className = "cm-mermaid-error";
			errorEl.textContent = this.error;
			wrapper.appendChild(errorEl);
		} else {
			const loadingEl = document.createElement("div");
			loadingEl.className = "cm-mermaid-loading";
			loadingEl.textContent = "Mermaid diagram loading...";
			wrapper.appendChild(loadingEl);
		}

		return wrapper;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

// ── Decoration builder ────────────────────────────────

/** buildMermaidDecorations の内部実装。decoration set に加えて、StateField の差分
 *  再構築判定 (blockFieldNeedsRebuild / cursorTouchesCandidates) が使う candidate
 *  範囲 (カーソル位置フィルタ前の mermaid ブロック全件) を返す。
 *  カーソル位置フィルタで hidden 化されるブロックも candidates に含める — math/table
 *  と同じく、隣接編集で候補が切り替わりうる以上、bail-early は安全側 (= full rebuild)
 *  に倒すべきため。 */
function buildMermaidDecorationsAndCandidates(
	state: EditorState,
	hasFocus: boolean,
): BlockFieldValue {
	const cursorLines = collectCursorLines(state, hasFocus);
	const blocks = findMermaidBlocks(state);
	const theme = useThemeStore.getState().theme;
	// init 失敗はグローバル 1 record なので block ごとに再評価せずループ前に 1 回で足りる
	// (renderMissing 側の shouldSkipMermaidInitRetry の hoist と対称的な扱い)。
	const initExhausted = isMermaidInitFailureExhausted();
	const ranges: Range<Decoration>[] = [];
	const candidates: CandidateRange[] = [];

	for (const block of blocks) {
		candidates.push({ from: block.from, to: block.to });

		const startLine = state.doc.lineAt(block.from).number;
		const endLine = state.doc.lineAt(block.to).number;

		if (cursorInRange(cursorLines, startLine, endLine)) continue;

		const entry = getCacheEntry(block.source, theme);
		let svg: string | null = null;
		let error: string | null = null;

		if (entry?.status === "rendered") {
			svg = entry.svg;
		} else if (entry?.status === "error") {
			error = entry.message;
		} else if (!entry && initExhausted) {
			// entry undefined かつ cap 到達 → 永久 loading を回避して user に失敗を可視化する。
			// cooldown 明けの view update で retry は継続する (lib 側の record は cap 到達後も
			// 残るが shouldSkipMermaidInitRetry は cooldown 経過で false を返す)。
			error = INIT_FAILURE_MESSAGE;
		}
		// status === "rendering" or undefined (未失敗 / cooldown 中) → loading state

		ranges.push(
			Decoration.replace({
				widget: new MermaidWidget(block.source, svg, error),
				block: true,
			}).range(block.from, block.to),
		);
	}

	return { decos: Decoration.set(ranges, true), candidates };
}

/** 公開 API: DecorationSet のみを返す (既存の呼び出し元 / テスト向けの後方互換ラッパー)。 */
export function buildMermaidDecorations(state: EditorState, hasFocus: boolean): DecorationSet {
	return buildMermaidDecorationsAndCandidates(state, hasFocus).decos;
}

// ── StateField ────────────────────────────────────────

/** mermaid candidate 判定の marker 文字 (fence)。挿入/削除テキストに ` か ~ が
 *  含まれれば新規候補の出現/消滅の可能性があるため full rebuild にフォールバックする。 */
// non-global にすることで `.test()` が stateless になり、呼び出しをまたいだ
// lastIndex 状態漏れ (false negative = rebuild 漏れ) が構造的に発生しなくなる。
const MERMAID_MARKER_RE = /`|~/;

/** テスト用に export。StateField 自体を state.field() で直接読むことで、
 *  update() の rebuild / skip 判定を EditorView / 実 focus イベントなしに検証できる
 *  （mermaid.test.ts 参照、math.ts の mathDecorationField と同型）。 */
export const mermaidDecorationField = StateField.define<BlockFieldValue>({
	create(state) {
		// 初期生成時は「フォーカスなし」とみなし、すべてのブロックをプレビュー表示する。
		// エディタがフォーカスを得ると focusChangeHandler が実際の hasFocus で再構築する。
		return buildMermaidDecorationsAndCandidates(state, false);
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(rebuildMermaidDecos)) {
				return buildMermaidDecorationsAndCandidates(tr.state, e.value);
			}
			if (e.is(treeParseProgressed)) {
				return buildMermaidDecorationsAndCandidates(tr.state, tr.state.field(hasFocusField));
			}
		}
		if (tr.docChanged) {
			if (blockFieldNeedsRebuild(tr, value.candidates, MERMAID_MARKER_RE)) {
				return buildMermaidDecorationsAndCandidates(tr.state, tr.state.field(hasFocusField));
			}
			return {
				decos: value.decos.map(tr.changes),
				candidates: mapCandidates(value.candidates, tr.changes),
			};
		}
		// mermaid はカーソルが fence 内に入るとブロックが hidden 化して source 表示に
		// 切り替わる (table と異なり見た目が hasFocus/cursor に連動する) ため、
		// selection 変化でも candidates と交差すれば rebuild が必要。
		if (tr.selection && cursorTouchesCandidates(tr, value.candidates)) {
			return buildMermaidDecorationsAndCandidates(tr.state, tr.state.field(hasFocusField));
		}
		return value;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

// ── ViewPlugin (async render + theme watch) ───────────

const mermaidRenderPlugin = ViewPlugin.fromClass(
	class {
		private view: EditorView;
		private prevCursorLines: Set<number> = new Set();
		private pendingRender = false;
		private debounceTimer: ReturnType<typeof setTimeout> | null = null;
		private destroyed = false;
		private unsubscribeTheme: (() => void) | null = null;
		private unsubscribeSettings: (() => void) | null = null;
		private lastTheme: string;
		private lastFontFamily: string;
		private lastFontSize: number;
		private rebuildScheduled = false;

		constructor(view: EditorView) {
			this.view = view;
			this.prevCursorLines = collectCursorLines(view);
			this.lastTheme = useThemeStore.getState().theme;
			const settings = useSettingsStore.getState();
			this.lastFontFamily = settings.fontFamily;
			this.lastFontSize = settings.fontSize;
			this.triggerRender();

			// Watch for theme changes
			this.unsubscribeTheme = useThemeStore.subscribe((state) => {
				if (state.theme !== this.lastTheme) {
					this.lastTheme = state.theme;
					this.resetCachesAndRerender();
				}
			});

			// Watch for font setting changes
			this.unsubscribeSettings = useSettingsStore.subscribe((state) => {
				if (state.fontFamily !== this.lastFontFamily || state.fontSize !== this.lastFontSize) {
					this.lastFontFamily = state.fontFamily;
					this.lastFontSize = state.fontSize;
					this.resetCachesAndRerender();
				}
			});
		}

		update(update: ViewUpdate) {
			this.view = update.view;

			if (this.pendingRender) {
				this.pendingRender = false;
				this.prevCursorLines = collectCursorLines(update.view);
				this.triggerRender();
				return;
			}

			const forceRebuild =
				update.docChanged ||
				update.viewportChanged ||
				syntaxTree(update.state) !== syntaxTree(update.startState);
			if (forceRebuild) {
				this.prevCursorLines = collectCursorLines(update.view);
				this.triggerRender();
			} else if (update.selectionSet || update.focusChanged) {
				const next = collectCursorLines(update.view);
				if (cursorLinesChanged(this.prevCursorLines, next)) {
					this.prevCursorLines = next;
					this.triggerRender();
				}
			}
		}

		private resetCachesAndRerender() {
			// clearMermaidCache が cache + init-failure record + lastInitKey を原子的に
			// リセットする (issue #384)。
			clearMermaidCache();
			this.triggerRender();
		}

		private triggerRender() {
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.debounceTimer = setTimeout(() => {
				if (this.destroyed) return;
				this.renderMissing();
			}, 300);
		}

		/** RAF で複数の dispatch 要求を 1 フレームに集約する */
		private scheduleRebuild() {
			if (this.rebuildScheduled || this.destroyed) return;
			this.rebuildScheduled = true;
			requestAnimationFrame(() => {
				this.rebuildScheduled = false;
				if (this.destroyed) return;
				this.pendingRender = true;
				this.view.dispatch({
					effects: rebuildMermaidDecos.of(this.view.hasFocus),
				});
			});
		}

		private renderMissing() {
			const state = this.view.state;
			const theme = useThemeStore.getState().theme;
			const visibleRanges = this.view.visibleRanges;

			// ビューポート範囲に限定してツリーを走査する
			const visibleBlocks: MermaidBlock[] = [];
			for (const range of visibleRanges) {
				for (const block of findMermaidBlocks(state, range)) {
					visibleBlocks.push(block);
				}
			}

			// init 失敗は source に依存しないグローバル状態 (issue #384)。ループ前に 1 回評価。
			const skipInit = shouldSkipMermaidInitRetry();
			let needsRebuild = false;
			for (const block of visibleBlocks) {
				const entry = getCacheEntry(block.source, theme);
				if (entry) continue; // Already cached (rendered, error, or rendering)
				if (skipInit) continue;

				needsRebuild = true;
				// 成功/失敗いずれも lib 内 (queue 内 `cacheGeneration` guard) で record は完結。
				renderMermaid(block.source, theme)
					.then(() => this.scheduleRebuild())
					.catch(() => this.scheduleRebuild());
			}

			// 未キャッシュのレンダリングを開始した場合、または
			// ツリーが初回の StateField 更新時に不完全だった可能性がある場合に
			// デコレーション再構築を保証する（例: Undo 後）
			if (needsRebuild) {
				this.scheduleRebuild();
			}
		}

		destroy() {
			this.destroyed = true;
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.unsubscribeTheme?.();
			this.unsubscribeSettings?.();
		}
	},
);

// ── Click handler ─────────────────────────────────────

function createMermaidClickHandler() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, _view: EditorView) {
			const target = event.target as HTMLElement;
			if (target.closest(".cm-mermaid-widget")) {
				// カーソルを移動しない。移動するとデコレーション再計算で
				// ウィジェットが消失する可能性がある（シンタックスツリーの
				// 不完全パース時や文書末尾ブロックなどのエッジケース）。
				// 編集は右クリックメニューの「Mermaid を編集」から行う。
				// view.focus() は呼ばない。focusChanged が発火するとデコレーション
				// 再構築でウィジェットが消失するため。
				event.preventDefault();
				return true;
			}
			return false;
		},
		contextmenu(event: MouseEvent, view: EditorView) {
			const target = event.target as HTMLElement;
			const mermaidEl = target.closest(".cm-mermaid-widget");

			if (mermaidEl) {
				const pos = view.posAtDOM(mermaidEl);
				const blocks = findMermaidBlocks(view.state);
				const block = blocks.find((b) => b.from <= pos && b.to >= pos);
				if (!block) return false;

				event.preventDefault();
				view.dom.dispatchEvent(
					new CustomEvent("mermaid-context-menu", {
						bubbles: true,
						detail: {
							source: block.source,
							from: block.from,
							to: block.to,
							clientX: event.clientX,
							clientY: event.clientY,
						},
					}),
				);
				return true;
			}

			// Mermaid 以外の領域ではネイティブコンテキストメニューを維持
			return false;
		},
	});
}

// ── Focus change handler ──────────────────────────────

const focusChangeHandler = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (update.focusChanged) {
				const { view } = update;
				queueMicrotask(() => {
					view.dispatch({ effects: rebuildMermaidDecos.of(view.hasFocus) });
				});
			}
		}
	},
);

// ── Extension ─────────────────────────────────────────

export const mermaidDecoration: Extension = [
	hasFocusField,
	mermaidDecorationField,
	mermaidRenderPlugin,
	// treeChangeDispatcher は tableDecoration でも個別に include されるが、
	// CodeMirror が ViewPlugin インスタンス同一性で dedup するため二重登録は無害。
	treeChangeDispatcher,
	focusChangeHandler,
	createMermaidClickHandler(),
];
