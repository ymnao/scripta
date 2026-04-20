import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";

const MERMAID_FENCE_RE = /^`{3,}\s*mermaid\s*$/;

const codeBlockFirstDecoration = Decoration.line({
	attributes: { class: "cm-codeblock-first" },
});

const COPY_ICON_SVG = `<svg class="cm-copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON_SVG = `<svg class="cm-codeblock-copy-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

export class CodeBlockCopyWidget extends WidgetType {
	readonly code: string;

	constructor(code: string) {
		super();
		this.code = code;
	}

	eq(other: CodeBlockCopyWidget): boolean {
		return this.code === other.code;
	}

	toDOM(): HTMLElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "cm-codeblock-copy";
		button.setAttribute("aria-label", "Copy code");
		button.setAttribute("title", "Copy");
		button.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;

		let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
		const copy = () => {
			if (!navigator.clipboard) return;
			navigator.clipboard.writeText(this.code).then(
				() => {
					if (feedbackTimer !== undefined) clearTimeout(feedbackTimer);
					button.classList.add("cm-codeblock-copy-success");
					feedbackTimer = setTimeout(() => {
						button.classList.remove("cm-codeblock-copy-success");
						feedbackTimer = undefined;
					}, 1500);
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
			}
		});

		return button;
	}

	ignoreEvent(event: Event): boolean {
		return event.type === "mousedown" || event.type === "click" || event.type === "keydown";
	}
}

function findCopyButtonForBlock(lineEl: Element): HTMLElement | null {
	if (lineEl.classList.contains("cm-codeblock-first")) {
		return lineEl.querySelector(".cm-codeblock-copy") as HTMLElement | null;
	}
	let el: Element | null = lineEl.previousElementSibling;
	while (el?.classList.contains("cm-codeblock-line")) {
		if (el.classList.contains("cm-codeblock-first")) {
			return el.querySelector(".cm-codeblock-copy") as HTMLElement | null;
		}
		el = el.previousElementSibling;
	}
	el = lineEl.nextElementSibling;
	while (el?.classList.contains("cm-codeblock-line")) {
		if (el.classList.contains("cm-codeblock-first")) {
			return el.querySelector(".cm-codeblock-copy") as HTMLElement | null;
		}
		el = el.nextElementSibling;
	}
	return null;
}

export function buildCopyDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);
	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name !== "FencedCode") return;

				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);

				if (MERMAID_FENCE_RE.test(startLine.text.trim())) return;
				if (endLine.number - startLine.number < 2) return;

				const code = state.doc.sliceString(startLine.to + 1, endLine.from - 1);
				if (code.length === 0) return;

				const firstContentLine = state.doc.line(startLine.number + 1);
				if (firstContentLine.from < from || firstContentLine.from > to) return;

				ranges.push(codeBlockFirstDecoration.range(firstContentLine.from, firstContentLine.from));
				ranges.push(
					Decoration.widget({
						widget: new CodeBlockCopyWidget(code),
						side: 1,
					}).range(firstContentLine.to),
				);
			},
		});
	}

	return Decoration.set(ranges, true);
}

class CodeBlockCopyPlugin implements PluginValue {
	decorations: DecorationSet;
	activeButton: HTMLElement | null = null;

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
		mouseover(this: CodeBlockCopyPlugin, event: MouseEvent) {
			const target = event.target as HTMLElement;
			const lineEl = target.closest(".cm-codeblock-line");

			if (!lineEl) {
				if (this.activeButton) {
					this.activeButton.classList.remove("cm-codeblock-copy-visible");
					this.activeButton = null;
				}
				return;
			}

			const btn = findCopyButtonForBlock(lineEl);
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
