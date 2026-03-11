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
import { clearMermaidCache, getCacheEntry, renderMermaid } from "../../../lib/mermaid";
import { useThemeStore } from "../../../stores/theme";

// ── Effects ───────────────────────────────────────────

/** hasFocus の実値を運ぶ Effect。推定ではなく view.hasFocus を渡す。 */
const rebuildMermaidDecos = StateEffect.define<boolean>();

// ── Types ─────────────────────────────────────────────

interface MermaidBlock {
	from: number;
	to: number;
	source: string;
}

// ── Helpers ───────────────────────────────────────────

/** Collect cursor line numbers. Returns empty set when unfocused. */
function collectCursorLines(state: EditorState, hasFocus: boolean): Set<number> {
	const lines = new Set<number>();
	if (!hasFocus) return lines;
	for (const range of state.selection.ranges) {
		const fromLine = state.doc.lineAt(range.from).number;
		const toLine = state.doc.lineAt(range.to).number;
		for (let l = fromLine; l <= toLine; l++) {
			lines.add(l);
		}
	}
	return lines;
}

/** Check if any cursor line falls within the given line range (inclusive). */
function cursorInBlock(cursorLines: Set<number>, startLine: number, endLine: number): boolean {
	for (let l = startLine; l <= endLine; l++) {
		if (cursorLines.has(l)) return true;
	}
	return false;
}

/** Find all mermaid fenced code blocks in the document. */
export function findMermaidBlocks(state: EditorState): MermaidBlock[] {
	const tree = syntaxTree(state);
	const blocks: MermaidBlock[] = [];

	tree.iterate({
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
	constructor(
		readonly source: string,
		readonly svg: string | null,
		readonly error: string | null,
	) {
		super();
	}

	eq(other: MermaidWidget): boolean {
		return this.source === other.source && this.svg === other.svg && this.error === other.error;
	}

	toDOM(): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = "cm-mermaid-widget";

		if (this.svg) {
			// useMaxWidth: true (デフォルト) により Mermaid は SVG に
			// width="100%" + style="max-width: Xpx" を設定する。
			// この max-width を 0.75 倍に縮小することで、
			// シンプルな図の自然な幅を抑えつつ viewBox による
			// 比例スケーリングでノード・文字・矢印すべてが縮小される。
			// コンテナ (.cm-mermaid-inner) の max-width が最終的な上限。
			const inner = document.createElement("div");
			inner.className = "cm-mermaid-inner";
			inner.innerHTML = this.svg;
			const svgEl = inner.querySelector("svg");
			if (svgEl) {
				const mw = svgEl.style.maxWidth;
				if (mw) {
					// flowchart, sequence 等: max-width を 1.5 倍に拡大
					const natural = Number.parseFloat(mw);
					if (!Number.isNaN(natural)) {
						svgEl.style.maxWidth = `${natural * 1.35}px`;
					}
				} else {
					// gantt, pie, gitGraph 等: max-width なしで
					// width="100%" height="100%" のパターン。
					// コンテナ幅いっぱいに表示する。
					svgEl.setAttribute("width", "100%");
				}
				// height を除去し viewBox のアスペクト比で自動算出させる
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

		if (cursorInBlock(cursorLines, startLine, endLine)) continue;

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
		// 初期生成時は安全側に「フォーカスあり」とみなしてデコレーションを構築する
		return buildMermaidDecorations(state, true);
	},
	update(decos, tr) {
		// Effect 経由の場合は実際の hasFocus 値を使用
		for (const e of tr.effects) {
			if (e.is(rebuildMermaidDecos)) {
				return buildMermaidDecorations(tr.state, e.value);
			}
		}
		if (tr.docChanged || tr.selectionSet) {
			// doc/selection 変更時はユーザー操作中なので必ずフォーカスあり
			return buildMermaidDecorations(tr.state, true);
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
		private lastTheme: string;

		constructor(view: EditorView) {
			this.view = view;
			this.lastTheme = useThemeStore.getState().theme;
			this.triggerRender();

			// Watch for theme changes
			this.unsubscribeTheme = useThemeStore.subscribe((state) => {
				if (state.theme !== this.lastTheme) {
					this.lastTheme = state.theme;
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

		private renderMissing() {
			const state = this.view.state;
			const blocks = findMermaidBlocks(state);
			const theme = useThemeStore.getState().theme;
			const visibleRanges = this.view.visibleRanges;

			// ビューポートに重なるブロックのみレンダリング（重い処理の軽減）
			const visibleBlocks = blocks.filter((block) =>
				visibleRanges.some((range) => range.from <= block.to && range.to >= block.from),
			);

			for (const block of visibleBlocks) {
				const entry = getCacheEntry(block.source, theme);
				if (entry) continue; // Already cached (rendered, error, or rendering)

				renderMermaid(block.source, theme)
					.then(() => {
						if (this.destroyed) return;
						this.pendingRender = true;
						this.view.dispatch({
							effects: rebuildMermaidDecos.of(this.view.hasFocus),
						});
					})
					.catch(() => {
						if (this.destroyed) return;
						this.pendingRender = true;
						this.view.dispatch({
							effects: rebuildMermaidDecos.of(this.view.hasFocus),
						});
					});
			}

			// ツリーが初回の StateField 更新時に不完全だった場合に備え、
			// デコレーション再構築を保証する（例: Undo 後）
			if (this.destroyed) return;
			this.view.dispatch({ effects: rebuildMermaidDecos.of(this.view.hasFocus) });
		}

		destroy() {
			this.destroyed = true;
			if (this.debounceTimer) clearTimeout(this.debounceTimer);
			this.unsubscribeTheme?.();
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

/** Find the FencedCode block surrounding `pos`. */
function findFencedCodeBlock(view: EditorView, pos: number): { from: number; to: number } | null {
	const line = view.state.doc.lineAt(pos);
	const tree = syntaxTree(view.state);
	let result: { from: number; to: number } | null = null;
	tree.iterate({
		from: line.from,
		to: Math.min(line.from + 10000, view.state.doc.length),
		enter(node) {
			if (node.name === "FencedCode" && node.from <= pos && node.to >= pos) {
				result = { from: node.from, to: node.to };
				return false;
			}
		},
	});
	return result;
}

function createMermaidClickHandler() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, view: EditorView) {
			const target = event.target as HTMLElement;
			const mermaidEl = target.closest(".cm-mermaid-widget");
			if (!mermaidEl) return false;

			const pos = view.posAtDOM(mermaidEl);
			const block = findFencedCodeBlock(view, pos);

			event.preventDefault();
			view.dispatch({
				selection: { anchor: block?.to ?? view.state.doc.lineAt(pos).to },
			});
			view.focus();
			return true;
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
	mermaidDecorationField,
	mermaidRenderPlugin,
	treeChangeDetector,
	focusChangeHandler,
	createMermaidClickHandler(),
];
