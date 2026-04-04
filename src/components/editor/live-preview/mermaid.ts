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
	isTauriProtocol,
	promoteMermaidStyles,
	renderMermaid,
} from "../../../lib/mermaid";
import { useSettingsStore } from "../../../stores/settings";
import { useThemeStore } from "../../../stores/theme";
import { collectCursorLines, cursorInRange } from "./cursor-utils";

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
				// bakeStyledSvg で焼き込み済みだが、WKWebView では innerHTML 再パース後に
				// fill/stroke 等の CSS→属性変換が必要なため再適用する。
				if (isTauriProtocol) {
					promoteMermaidStyles(svgEl);
				}

				// max-width を SVG の style 属性から取得。
				// WKWebView tauri:// は SVG の style 属性を CSSOM に反映しない
				// 可能性があるため、属性文字列と viewBox もフォールバックとして使う。
				let mw: string | undefined;
				const cssom = svgEl.style.maxWidth;
				if (cssom) {
					mw = cssom;
				} else {
					const styleAttr = svgEl.getAttribute("style") ?? "";
					const match = styleAttr.match(/max-width:\s*([\d.]+)px/);
					if (match) {
						mw = `${match[1]}px`;
					}
				}
				if (!mw) {
					const vb = svgEl.getAttribute("viewBox");
					if (vb) {
						const parts = vb.split(/\s+/);
						if (parts.length === 4) {
							mw = `${parts[2]}px`;
						}
					}
				}

				if (mw) {
					const natural = Number.parseFloat(mw);
					if (!Number.isNaN(natural)) {
						const scaledMaxWidth = `${natural * 1.35}px`;
						// max-width を SVG ではなくコンテナ div に設定する。
						// WKWebView tauri:// は SVG 要素の CSS max-width を処理しないが、
						// HTML 要素の max-width は正常に機能する。
						inner.style.maxWidth = scaledMaxWidth;
						// 通常ブラウザでは SVG 自身の max-width も有効なため、
						// 同じ値に更新して元の上限幅で頭打ちになるのを防ぐ。
						svgEl.style.maxWidth = scaledMaxWidth;
					}
				}
				// SVG は viewBox でアスペクト比を保持しコンテナ幅に合わせる
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

export function buildMermaidDecorations(state: EditorState, hasFocus: boolean): DecorationSet {
	const cursorLines = collectCursorLines(state, hasFocus);
	const blocks = findMermaidBlocks(state);
	const theme = useThemeStore.getState().theme;
	const ranges: Range<Decoration>[] = [];

	for (const block of blocks) {
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
		}
		// status === "rendering" or undefined → loading state

		ranges.push(
			Decoration.replace({
				widget: new MermaidWidget(block.source, svg, error),
				block: true,
			}).range(block.from, block.to),
		);
	}

	return Decoration.set(ranges, true);
}

// ── StateField ────────────────────────────────────────

const mermaidDecorationField = StateField.define<DecorationSet>({
	create(state) {
		// 初期生成時は「フォーカスなし」とみなし、すべてのブロックをプレビュー表示する。
		// エディタがフォーカスを得ると focusChangeHandler が実際の hasFocus で再構築する。
		return buildMermaidDecorations(state, false);
	},
	update(decos, tr) {
		// Effect 経由の場合は実際の hasFocus 値を使用
		for (const e of tr.effects) {
			if (e.is(rebuildMermaidDecos)) {
				return buildMermaidDecorations(tr.state, e.value);
			}
		}
		if (tr.docChanged || tr.selection) {
			// hasFocusField から実フォーカス値を参照（プログラム的な変更にも対応）
			return buildMermaidDecorations(tr.state, tr.state.field(hasFocusField));
		}
		return decos;
	},
	provide: (f) => EditorView.decorations.from(f),
});

// ── ViewPlugin (async render + theme watch) ───────────

const mermaidRenderPlugin = ViewPlugin.fromClass(
	class {
		private view: EditorView;
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
			this.lastTheme = useThemeStore.getState().theme;
			const settings = useSettingsStore.getState();
			this.lastFontFamily = settings.fontFamily;
			this.lastFontSize = settings.fontSize;
			this.triggerRender();

			// Watch for theme changes
			this.unsubscribeTheme = useThemeStore.subscribe((state) => {
				if (state.theme !== this.lastTheme) {
					this.lastTheme = state.theme;
					clearMermaidCache();
					this.triggerRender();
				}
			});

			// Watch for font setting changes
			this.unsubscribeSettings = useSettingsStore.subscribe((state) => {
				if (state.fontFamily !== this.lastFontFamily || state.fontSize !== this.lastFontSize) {
					this.lastFontFamily = state.fontFamily;
					this.lastFontSize = state.fontSize;
					clearMermaidCache();
					this.triggerRender();
				}
			});
		}

		update(update: ViewUpdate) {
			this.view = update.view;

			if (this.pendingRender) {
				this.pendingRender = false;
				this.triggerRender();
				return;
			}

			if (
				update.docChanged ||
				update.viewportChanged ||
				update.selectionSet ||
				update.focusChanged ||
				syntaxTree(update.state) !== syntaxTree(update.startState)
			) {
				this.triggerRender();
			}
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

			let needsRebuild = false;
			for (const block of visibleBlocks) {
				const entry = getCacheEntry(block.source, theme);
				if (entry) continue; // Already cached (rendered, error, or rendering)

				needsRebuild = true;
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

// ── Tree-change detector ──────────────────────────────

const treeChangeDetector = ViewPlugin.fromClass(
	class {
		update(update: ViewUpdate) {
			if (!update.docChanged && syntaxTree(update.state) !== syntaxTree(update.startState)) {
				const { view } = update;
				queueMicrotask(() => {
					view.dispatch({ effects: rebuildMermaidDecos.of(view.hasFocus) });
				});
			}
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
	treeChangeDetector,
	focusChangeHandler,
	createMermaidClickHandler(),
];
