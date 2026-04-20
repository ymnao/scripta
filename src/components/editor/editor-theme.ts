import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { FontFamily } from "../../lib/store";

/**
 * IME コンポジション中にエディタへ cm-composing クラスを付与する。
 * drawSelection 有効時でも WKWebView 上の CJK IME で
 * .cm-selectionBackground が残る場合があるため、CSS で抑制する。
 */
export const composingClass = ViewPlugin.fromClass(
	class {
		private view: EditorView;
		constructor(view: EditorView) {
			this.view = view;
			view.contentDOM.addEventListener("compositionstart", this.onStart);
			view.contentDOM.addEventListener("compositionend", this.onEnd);
		}
		private onStart = () => {
			this.view.dom.classList.add("cm-composing");
		};
		private onEnd = () => {
			this.view.dom.classList.remove("cm-composing");
		};
		destroy() {
			this.view.contentDOM.removeEventListener("compositionstart", this.onStart);
			this.view.contentDOM.removeEventListener("compositionend", this.onEnd);
			this.view.dom.classList.remove("cm-composing");
		}
	},
);

export const FONT_FAMILY_MAP: Record<FontFamily, string> = {
	monospace: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
	"sans-serif": "system-ui, -apple-system, sans-serif",
	serif: "Georgia, 'Times New Roman', serif",
};

export function createDynamicEditorTheme(fontSize: number, contentPadding = "8px 48px") {
	return EditorView.theme({
		"&": {
			height: "100%",
			fontSize: `${fontSize}px`,
			backgroundColor: "var(--color-bg-primary)",
			color: "var(--color-text-primary)",
		},
		".cm-content": {
			padding: contentPadding,
			fontSynthesis: "style",
			overflowWrap: "break-word",
		},
		".cm-line": {
			padding: "1px 0",
			overflowWrap: "break-word",
		},
	});
}

export const staticEditorTheme = EditorView.theme({
	"&.cm-focused .cm-cursor": {
		borderLeftColor: "var(--color-text-primary)",
	},
	".cm-gutters": {
		backgroundColor: "var(--color-bg-primary)",
		color: "var(--color-text-secondary)",
		border: "none",
		fontSize: "0.85em",
		minWidth: "3em",
	},
	".cm-lineNumbers .cm-gutterElement": {
		padding: "0 8px 0 12px",
	},
	".cm-activeLineGutter": {
		backgroundColor: "transparent",
		color: "var(--color-text-primary)",
	},
	".cm-foldGutter .cm-gutterElement": {
		padding: "0 4px",
		cursor: "pointer",
		color: "var(--color-text-secondary)",
		opacity: "0",
		transition: "opacity 0.15s",
	},
	".cm-gutters:hover .cm-foldGutter .cm-gutterElement": {
		opacity: "1",
	},
	".cm-foldGutter .cm-gutterElement[aria-label]": {
		opacity: "1",
	},
	".cm-foldPlaceholder": {
		display: "none",
	},
	".cm-selectionBackground": {
		background: "color-mix(in srgb, var(--color-text-secondary) 25%, transparent) !important",
	},
	"&.cm-composing .cm-selectionBackground": {
		background: "transparent !important",
	},
	".cm-heading-1": {
		fontSize: "1.8em",
		fontWeight: "700",
		lineHeight: "1.3",
		padding: "0.6em 0 0.2em",
	},
	".cm-heading-2": {
		fontSize: "1.5em",
		fontWeight: "700",
		lineHeight: "1.3",
		padding: "0.5em 0 0.15em",
	},
	".cm-heading-3": {
		fontSize: "1.25em",
		fontWeight: "600",
		lineHeight: "1.3",
		padding: "0.4em 0 0.1em",
	},
	".cm-heading-4": {
		fontSize: "1.1em",
		fontWeight: "600",
		lineHeight: "1.3",
		padding: "0.3em 0 0.1em",
	},
	".cm-heading-5": {
		fontSize: "1em",
		fontWeight: "600",
		lineHeight: "1.3",
		padding: "0.2em 0 0.05em",
	},
	".cm-heading-6": {
		fontSize: "0.9em",
		fontWeight: "600",
		lineHeight: "1.3",
		padding: "0.2em 0 0.05em",
	},
	".cm-strong": { fontWeight: "700" },
	".cm-emphasis": { fontStyle: "italic" },
	".cm-link-widget": {
		color: "var(--color-text-link)",
		textDecoration: "underline",
		cursor: "text",
	},
	".cm-link-widget-disabled": {
		textDecoration: "none",
		cursor: "default",
	},
	".cm-image-widget img": {
		maxWidth: "100%",
		maxHeight: "400px",
		display: "block",
		borderRadius: "4px",
		margin: "4px 0",
	},
	".cm-image-fallback": {
		display: "inline-block",
		padding: "2px 6px",
		borderRadius: "3px",
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 15%, transparent)",
		color: "var(--color-text-secondary)",
		fontSize: "0.85em",
	},
	".cm-codeblock-line": {
		backgroundColor: "var(--color-bg-secondary)",
		fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
	},
	".cm-codeblock-first": {
		position: "relative",
	},
	".cm-codeblock-copy": {
		position: "absolute",
		right: "4px",
		top: "0",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		width: "28px",
		height: "28px",
		border: "none",
		borderRadius: "4px",
		backgroundColor: "transparent",
		color: "var(--color-text-secondary)",
		cursor: "pointer",
		opacity: "0",
		pointerEvents: "none",
		transition: "opacity 0.15s, background-color 0.15s",
	},
	".cm-codeblock-copy:focus-visible": {
		opacity: "1",
		pointerEvents: "auto",
		outline: "2px solid var(--color-text-link)",
		outlineOffset: "1px",
	},
	".cm-codeblock-copy-visible": {
		opacity: "1",
		pointerEvents: "auto",
	},
	".cm-codeblock-copy-visible:hover": {
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 15%, transparent)",
	},
	".cm-codeblock-copy-success": {
		color: "#22c55e",
		opacity: "1",
		pointerEvents: "auto",
	},
	".cm-codeblock-copy-check": {
		display: "none",
	},
	".cm-codeblock-copy-success .cm-copy-icon": {
		display: "none",
	},
	".cm-codeblock-copy-success .cm-codeblock-copy-check": {
		display: "block",
	},
	".cm-list-marker": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "flex-start",
		verticalAlign: "middle",
		transform: "translateY(-0.08em)",
		width: "2ch",
		flexShrink: "0",
	},
	".cm-task-checkbox": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		boxSizing: "border-box",
		width: "0.85em",
		height: "0.85em",
		borderRadius: "3px",
		border: "1.5px solid var(--color-text-secondary)",
		cursor: "pointer",
		backgroundColor: "transparent",
		transition: "background-color 0.15s, border-color 0.15s",
		flexShrink: "0",
	},
	".cm-task-checkbox-checked": {
		backgroundColor: "var(--color-text-link)",
		borderColor: "var(--color-text-link)",
		color: "white",
	},
	".cm-task-checkmark": {
		width: "0.6em",
		height: "0.6em",
	},
	".cm-table-widget": {
		padding: "8px 0",
	},
	".cm-table-widget table": {
		borderCollapse: "collapse",
	},
	".cm-table-cell": {
		border: "1px solid var(--color-border)",
		padding: "6px 12px",
		minWidth: "6em",
		outline: "none",
	},
	".cm-table-cell:focus": {
		boxShadow: "inset 0 0 0 2px var(--color-text-link)",
	},
	".cm-table-widget th": {
		fontWeight: "700",
	},
	".cm-blockquote-line": {
		borderLeft: "3px solid var(--color-border)",
		paddingLeft: "8px",
	},
	".cm-hr-widget": {
		border: "none",
		borderTop: "1px solid var(--color-border)",
		margin: "8px 0",
	},
	".cm-strikethrough": {
		textDecoration: "line-through",
	},
	".cm-task-checked": {
		textDecoration: "line-through",
		opacity: "0.6",
		color: "var(--color-text-secondary)",
	},
	".cm-bullet-mark": {
		color: "var(--color-text-secondary)",
		fontSize: "0.75em",
	},
	".cm-searchMatch": {
		backgroundColor: "color-mix(in srgb, #facc15 30%, transparent)",
	},
	".cm-searchMatch-selected": {
		backgroundColor: "color-mix(in srgb, #f97316 40%, transparent)",
	},
	".cm-math-display": {
		display: "block",
		textAlign: "center",
		padding: "8px 0",
		overflowX: "auto",
	},
	".cm-math-inline": {
		display: "inline",
	},
	".cm-math-error": {
		fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 10%, transparent)",
		color: "var(--color-text-secondary)",
	},
	".cm-wikilink": {
		color: "var(--color-text-link)",
		cursor: "pointer",
		textDecoration: "underline",
	},
	".cm-wikilink-missing": {
		opacity: "0.6",
		textDecoration: "underline dashed",
	},
	".cm-wikilink-missing:hover": {
		opacity: "0.8",
		cursor: "help",
	},
	".cm-mermaid-widget": {
		display: "flex",
		justifyContent: "center",
		padding: "8px 0",
		margin: "4px 0",
		overflow: "hidden",
	},
	".cm-mermaid-inner": {
		width: "100%",
		textAlign: "center",
	},
	".cm-mermaid-inner svg": {
		display: "inline-block",
	},
	".cm-mermaid-loading": {
		color: "var(--color-text-secondary)",
		fontSize: "0.85em",
		padding: "12px 0",
	},
	".cm-mermaid-error": {
		fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
		fontSize: "0.85em",
		color: "#dc2626",
		backgroundColor: "color-mix(in srgb, #dc2626 8%, transparent)",
		padding: "8px 12px",
		borderRadius: "4px",
		whiteSpace: "pre-wrap",
	},
	".cm-link-card": {
		display: "block",
		border: "1px solid var(--color-border)",
		borderRadius: "8px",
		padding: "8px 12px",
		maxWidth: "600px",
		cursor: "pointer",
		transition: "background-color 0.15s",
		margin: "2px 0",
		color: "inherit",
		textDecoration: "none",
	},
	".cm-link-card:hover": {
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 8%, transparent)",
	},
	".cm-link-card-loading": {
		color: "var(--color-text-secondary)",
		fontSize: "0.85em",
	},
	".cm-link-card-content": {
		display: "flex",
		gap: "12px",
		alignItems: "flex-start",
	},
	".cm-link-card-text": {
		flex: "1",
		minWidth: "0",
		overflow: "hidden",
	},
	".cm-link-card-title": {
		fontWeight: "600",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	},
	".cm-link-card-description": {
		fontSize: "0.8em",
		color: "var(--color-text-secondary)",
		marginTop: "4px",
		display: "-webkit-box",
		WebkitLineClamp: "2",
		WebkitBoxOrient: "vertical",
		overflow: "hidden",
	},
	".cm-link-card-domain": {
		fontSize: "0.75em",
		color: "var(--color-text-secondary)",
		marginTop: "4px",
	},
	".cm-link-card-thumbnail-wrapper": {
		flexShrink: "0",
	},
	".cm-link-card-thumbnail": {
		width: "120px",
		height: "80px",
		objectFit: "cover",
		borderRadius: "4px",
	},
	// Autocomplete (wikilink completion) tooltip
	".cm-tooltip.cm-tooltip-autocomplete": {
		backgroundColor: "var(--color-bg-primary)",
		border: "1px solid var(--color-border)",
		borderRadius: "6px",
		boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
		overflow: "hidden",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul": {
		fontFamily: "inherit",
		maxHeight: "240px",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
		padding: "4px 8px",
		color: "var(--color-text-primary)",
		display: "flex",
		alignItems: "center",
		gap: "6px",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
		backgroundColor: "color-mix(in srgb, var(--color-text-link) 15%, transparent)",
		color: "var(--color-text-primary)",
	},
	".cm-completionLabel": {
		fontSize: "13px",
	},
	".cm-completionDetail": {
		fontSize: "11px",
		color: "var(--color-text-secondary)",
		fontStyle: "normal",
		marginLeft: "auto",
		overflow: "hidden",
		textOverflow: "ellipsis",
	},
});

/** CSS 変数ベースのシンタックスハイライト。ライト/ダーク両対応。
 *  defaultHighlightStyle (fallback) でカバーされないタグ色を CSS 変数で上書きする。 */
export const codeHighlightStyle = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.heading, fontWeight: "bold" },
		{ tag: tags.link, textDecoration: "none" },
		{ tag: tags.emphasis, fontStyle: "italic" },
		{ tag: tags.strong, fontWeight: "bold" },
		{ tag: tags.strikethrough, textDecoration: "line-through" },
		{ tag: tags.keyword, color: "var(--color-syntax-keyword)" },
		{ tag: [tags.atom, tags.bool], color: "var(--color-syntax-atom)" },
		{ tag: tags.number, color: "var(--color-syntax-number)" },
		{ tag: [tags.string, tags.special(tags.string)], color: "var(--color-syntax-string)" },
		{ tag: tags.regexp, color: "var(--color-syntax-regexp)" },
		{ tag: tags.escape, color: "var(--color-syntax-escape)" },
		{ tag: tags.definition(tags.variableName), color: "var(--color-syntax-definition)" },
		{ tag: tags.function(tags.variableName), color: "var(--color-syntax-function)" },
		{ tag: tags.typeName, color: "var(--color-syntax-type)" },
		{ tag: tags.className, color: "var(--color-syntax-class)" },
		{ tag: tags.changed, color: "var(--color-syntax-changed)" },
		{ tag: tags.annotation, color: "var(--color-syntax-annotation)" },
		{ tag: tags.comment, color: "var(--color-syntax-comment)" },
		{ tag: tags.invalid, color: "var(--color-syntax-invalid)" },
	]),
);
