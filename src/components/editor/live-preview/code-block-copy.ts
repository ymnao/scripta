import { syntaxTree } from "@codemirror/language";
import type { Line, Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";

import { MERMAID_FENCE_RE } from "./code-blocks";

const copyAnchorDecoration = Decoration.line({
	attributes: { class: "cm-codeblock-copy-anchor" },
});

const COPY_ICON_SVG = `<svg class="cm-copy-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON_SVG = `<svg class="cm-codeblock-copy-check" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

const feedbackTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function resolveCodeContent(view: EditorView, dom: HTMLElement): string | null {
	try {
		const pos = view.posAtDOM(dom, 0);
		let node = syntaxTree(view.state).resolveInner(pos, 1);
		while (node.name !== "FencedCode") {
			const parent = node.parent;
			if (!parent) return null;
			node = parent;
		}
		const startLine = view.state.doc.lineAt(node.from);
		const endLine = view.state.doc.lineAt(node.to);
		const code = view.state.doc.sliceString(startLine.to + 1, endLine.from - 1);
		return code || null;
	} catch {
		return null;
	}
}

export class CodeBlockCopyWidget extends WidgetType {
	eq(_other: CodeBlockCopyWidget): boolean {
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "cm-codeblock-copy";
		button.setAttribute("aria-label", "Copy code");
		button.setAttribute("title", "Copy");
		button.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;

		const copy = () => {
			if (!navigator.clipboard) return;
			const code = resolveCodeContent(view, button);
			if (!code) return;
			navigator.clipboard.writeText(code).then(
				() => {
					const prev = feedbackTimers.get(button);
					if (prev !== undefined) clearTimeout(prev);
					button.classList.add("cm-codeblock-copy-success");
					feedbackTimers.set(
						button,
						setTimeout(() => {
							button.classList.remove("cm-codeblock-copy-success");
							feedbackTimers.delete(button);
						}, 1500),
					);
				},
				() => {},
			);
		};

		button.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});

		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			copy();
		});

		button.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				e.stopPropagation();
				copy();
				view.focus();
			}
		});

		return button;
	}

	destroy(dom: HTMLElement): void {
		const timer = feedbackTimers.get(dom);
		if (timer !== undefined) {
			clearTimeout(timer);
			feedbackTimers.delete(dom);
		}
	}

	ignoreEvent(event: Event): boolean {
		if (event.type === "mousedown" || event.type === "click") {
			return true;
		}
		if (event.type === "keydown" && event instanceof KeyboardEvent) {
			return event.key === "Enter" || event.key === " ";
		}
		return false;
	}
}

function getFencedCodeRange(
	view: EditorView,
	lineEl: Element,
): { from: number; to: number } | null {
	try {
		const pos = view.posAtDOM(lineEl, 0);
		let node = syntaxTree(view.state).resolveInner(pos, 1);
		while (node.name !== "FencedCode") {
			const parent = node.parent;
			if (!parent) return null;
			node = parent;
		}
		return { from: node.from, to: node.to };
	} catch {
		return null;
	}
}

type BlockRangeCache = WeakMap<Element, { from: number; to: number } | null>;

function getCachedBlockRange(
	cache: BlockRangeCache,
	view: EditorView,
	lineEl: Element,
): { from: number; to: number } | null {
	const cached = cache.get(lineEl);
	if (cached !== undefined) return cached;
	const range = getFencedCodeRange(view, lineEl);
	cache.set(lineEl, range);
	return range;
}

function findCopyButtonForBlock(
	view: EditorView,
	lineEl: Element,
	cache: BlockRangeCache,
): HTMLElement | null {
	const blockRange = getCachedBlockRange(cache, view, lineEl);
	if (!blockRange) return null;

	if (lineEl.classList.contains("cm-codeblock-copy-anchor")) {
		return lineEl.querySelector(".cm-codeblock-copy") as HTMLElement | null;
	}

	let el: Element | null = lineEl.previousElementSibling;
	while (el?.classList.contains("cm-codeblock-line")) {
		if (el.classList.contains("cm-codeblock-copy-anchor")) {
			const candidateRange = getCachedBlockRange(cache, view, el);
			if (candidateRange?.from === blockRange.from) {
				return el.querySelector(".cm-codeblock-copy") as HTMLElement | null;
			}
			break;
		}
		el = el.previousElementSibling;
	}

	el = lineEl.nextElementSibling;
	while (el?.classList.contains("cm-codeblock-line")) {
		if (el.classList.contains("cm-codeblock-copy-anchor")) {
			const candidateRange = getCachedBlockRange(cache, view, el);
			if (candidateRange?.from === blockRange.from) {
				return el.querySelector(".cm-codeblock-copy") as HTMLElement | null;
			}
			break;
		}
		el = el.nextElementSibling;
	}

	return null;
}

export function buildCopyDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);
	const ranges: Range<Decoration>[] = [];
	const processed = new Set<number>();

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name !== "FencedCode") return;
				if (processed.has(node.from)) return;
				processed.add(node.from);

				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);

				if (MERMAID_FENCE_RE.test(startLine.text.trim())) return;
				if (endLine.number - startLine.number < 2) return;

				if (startLine.to + 1 >= endLine.from - 1) return;

				const firstContentLineNum = startLine.number + 1;
				const lastContentLineNum = endLine.number - 1;
				const firstContentLine = state.doc.line(firstContentLineNum);

				let targetLine: Line;
				if (firstContentLine.from >= from) {
					targetLine = firstContentLine;
				} else {
					const lineAtFrom = state.doc.lineAt(from);
					if (lineAtFrom.number >= firstContentLineNum && lineAtFrom.number <= lastContentLineNum) {
						targetLine = lineAtFrom;
					} else {
						return;
					}
				}

				if (targetLine.from > to) return;

				ranges.push(copyAnchorDecoration.range(targetLine.from, targetLine.from));
				ranges.push(
					Decoration.widget({
						widget: new CodeBlockCopyWidget(),
						side: 1,
					}).range(targetLine.to),
				);
			},
		});
	}

	return Decoration.set(ranges, true);
}

class CodeBlockCopyPlugin implements PluginValue {
	decorations: DecorationSet;
	activeButton: HTMLElement | null = null;
	blockRangeCache: BlockRangeCache = new WeakMap();

	constructor(view: EditorView) {
		this.decorations = buildCopyDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}
		if (
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = buildCopyDecorations(update.view);
			this.blockRangeCache = new WeakMap();
			if (this.activeButton) {
				this.activeButton.classList.remove("cm-codeblock-copy-visible");
				this.activeButton = null;
			}
		}
	}
}

export const codeBlockCopyDecoration = ViewPlugin.fromClass(CodeBlockCopyPlugin, {
	decorations: (v) => v.decorations,
	eventHandlers: {
		mouseover(this: CodeBlockCopyPlugin, event: MouseEvent, view: EditorView) {
			const target = event.target as HTMLElement;
			const lineEl = target.closest(".cm-codeblock-line");

			if (!lineEl) {
				if (this.activeButton) {
					this.activeButton.classList.remove("cm-codeblock-copy-visible");
					this.activeButton = null;
				}
				return;
			}

			const btn = findCopyButtonForBlock(view, lineEl, this.blockRangeCache);
			if (btn === this.activeButton) return;

			if (this.activeButton) {
				this.activeButton.classList.remove("cm-codeblock-copy-visible");
			}
			if (btn) {
				btn.classList.add("cm-codeblock-copy-visible");
				this.activeButton = btn;
			}
		},
		mouseleave(this: CodeBlockCopyPlugin) {
			if (this.activeButton) {
				this.activeButton.classList.remove("cm-codeblock-copy-visible");
				this.activeButton = null;
			}
		},
	},
});
