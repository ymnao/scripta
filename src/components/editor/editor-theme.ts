import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { FontFamily } from "../../lib/store";

export const FONT_FAMILY_MAP: Record<FontFamily, string> = {
	monospace: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
	"sans-serif": "system-ui, -apple-system, sans-serif",
	serif: "Georgia, 'Times New Roman', serif",
};

export function createDynamicEditorTheme(fontSize: number, vertical = "8px", horizontal = "48px") {
	return EditorView.theme({
		"&": {
			height: "100%",
			fontSize: `${fontSize}px`,
			backgroundColor: "var(--color-bg-primary)",
			color: "var(--color-text-primary)",
		},
		// horizontal padding を .cm-line 側に持たせる。CodeMirror の RectangleMarker.forRange
		// (drawSelection) は selection rect の left/right を .cm-line の paddingLeft/Right で
		// 補正するため、.cm-content 側に horizontal padding を置くと selection が padding
		// 領域まではみ出す。
		".cm-content": {
			padding: `${vertical} 0`,
			fontSynthesis: "style",
			overflowWrap: "break-word",
			// static theme 側の consumer (.cm-codeblock-copy の right 補正、block widget の
			// margin 補正) が参照する。fallback 契約の詳細は .cm-codeblock-copy 側コメント参照。
			"--cm-horizontal-padding": horizontal,
		},
		".cm-line": {
			padding: `1px ${horizontal}`,
			overflowWrap: "break-word",
		},
		// blockquote 装飾。horizontal を直接補間するため dynamic theme 内に置き、
		// 同一 module 内で .cm-line { padding } shorthand より後 (key 順) に並べることで
		// paddingLeft longhand が確実に勝つ。
		// 注意: theme module は登録の逆順で mount されるため「dynamic が後に登録されるから
		// 勝つ」は成立しない (inter-module では static が後勝ち)。ここは同一 module 内の
		// key 順だけに依存している。
		// border は擬似要素で「テキスト直前 (= horizontal padding の位置)」に描画、
		// padding-left は horizontal + 11px (border 3px + 内側 8px) に拡張してテキスト位置を維持。
		".cm-blockquote-line": {
			position: "relative",
			paddingLeft: `calc(${horizontal} + 11px)`,
		},
		".cm-blockquote-line::before": {
			content: '""',
			position: "absolute",
			left: horizontal,
			top: "0",
			bottom: "0",
			width: "3px",
			backgroundColor: "var(--color-border)",
		},
	});
}

export const staticEditorTheme = EditorView.theme({
	"&.cm-focused .cm-cursor": {
		borderLeftColor: "var(--color-text-primary)",
	},
	// gap cursor (#167): 文書先頭/末尾がテーブルのとき、境界（gap）に留まるカーソルの
	// 描画。実体は table-decoration.ts の tableGapCursorLayer が置く水平バー。
	".cm-tableGapCursorLayer": {
		pointerEvents: "none",
	},
	// position: absolute は base theme の `.cm-layer > *` が当てる（cm-blink 同様、
	// layer 機構の base theme に依存する）
	".cm-table-gap-cursor": {
		display: "none",
		backgroundColor: "var(--color-text-primary)",
		borderRadius: "1px",
	},
	"&.cm-focused .cm-table-gap-cursor": {
		display: "block",
		// cm-blink keyframes は drawSelection の base theme が定義する
		animation: "steps(1) cm-blink 1.2s infinite",
	},
	// gap 滞在中は drawSelection の primary cursor（widget 全高の巨大キャレット）を隠し、
	// gap cursor バーに置き換える。multi-cursor の secondary が gap に来るケースは稀なので
	// 割り切って primary のみ対象にする。baseTheme の表示側セレクタ（class 5 個）との
	// specificity 競争は upstream の構造変更で静かに壊れるため、!important で降りる
	// （.cm-selectionBackground と同じ手法）。
	"&.cm-table-gap-active .cm-cursor-primary": {
		display: "none !important",
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
		transition: "opacity 0.15s ease-out",
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
	// 見出しは Decoration.line で .cm-line 自身に付く。padding は top/bottom の longhand
	// のみ指定すること — shorthand ("0.6em 0 0.2em" 等) だと left/right が 0 になり、
	// .cm-line (dynamic theme) の horizontal padding を打ち消して見出し行だけ左端に
	// 張り付く。theme module は登録の逆順で mount されるため、static theme が
	// dynamic theme より document 上で後ろ = 同 specificity では static が勝つ。
	".cm-heading-1": {
		fontSize: "1.8em",
		fontWeight: "700",
		lineHeight: "1.3",
		paddingTop: "0.6em",
		paddingBottom: "0.2em",
	},
	".cm-heading-2": {
		fontSize: "1.5em",
		fontWeight: "700",
		lineHeight: "1.3",
		paddingTop: "0.5em",
		paddingBottom: "0.15em",
	},
	".cm-heading-3": {
		fontSize: "1.25em",
		fontWeight: "600",
		lineHeight: "1.3",
		paddingTop: "0.4em",
		paddingBottom: "0.1em",
	},
	".cm-heading-4": {
		fontSize: "1.1em",
		fontWeight: "600",
		lineHeight: "1.3",
		paddingTop: "0.3em",
		paddingBottom: "0.1em",
	},
	".cm-heading-5": {
		fontSize: "1em",
		fontWeight: "600",
		lineHeight: "1.3",
		paddingTop: "0.2em",
		paddingBottom: "0.05em",
	},
	".cm-heading-6": {
		fontSize: "0.9em",
		fontWeight: "600",
		lineHeight: "1.3",
		paddingTop: "0.2em",
		paddingBottom: "0.05em",
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
	// cmd/ctrl 押下中は「クリックで開ける」サインとして pointer cursor。
	// `cm-link-mod-down` クラスは modifierTrackPlugin (links.ts) が editor の
	// 外側 wrapper (view.dom) に動的に付与する。
	"&.cm-link-mod-down .cm-link-widget:not(.cm-link-widget-disabled)": {
		cursor: "pointer",
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
		fontFamily: FONT_FAMILY_MAP.monospace,
		// .cm-line の horizontal padding 領域に背景がはみ出すのを content-box にクリップ。
		// 全ての editor で lineWrapping 有効前提 (long line が横スクロールしないため
		// content-box が常に viewport 幅と一致)。lineWrapping を切ると長い行の背景が
		// 切れて見える可能性あり。
		backgroundOrigin: "content-box",
		backgroundClip: "content-box",
	},
	".cm-codeblock-copy-anchor": {
		position: "relative",
	},
	".cm-codeblock-copy": {
		position: "absolute",
		// anchor (= .cm-codeblock-copy-anchor = .cm-line) 右端は .cm-line に horizontal
		// padding が乗っている分だけ codeblock 背景より右に出てしまうため、
		// --cm-horizontal-padding (dynamic theme が .cm-content に設定) 分内側へ補正。
		// fallback 0px は dynamic theme が何らかの理由で未適用でも right: 4px (= 元の
		// 静的値) で安全側に倒すための defense-in-depth。
		right: "calc(var(--cm-horizontal-padding, 0px) + 4px)",
		top: "50%",
		transform: "translateY(-50%)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		width: "1.25em",
		height: "1.25em",
		border: "none",
		borderRadius: "4px",
		backgroundColor: "transparent",
		color: "var(--color-text-secondary)",
		cursor: "pointer",
		opacity: "0",
		pointerEvents: "none",
		transition: "opacity 0.15s ease-out, background-color 0.15s ease-out",
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
		color: "var(--color-success, #22c55e)",
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
		transition: "background-color 0.15s ease-out, border-color 0.15s ease-out",
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
	".cm-table-cell-selected": {
		background: "color-mix(in srgb, var(--color-text-link) 15%, transparent)",
	},
	".cm-table-widget th": {
		fontWeight: "700",
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
		fontFamily: FONT_FAMILY_MAP.monospace,
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
		fontFamily: FONT_FAMILY_MAP.monospace,
		fontSize: "0.85em",
		color: "#dc2626",
		backgroundColor: "color-mix(in srgb, #dc2626 8%, transparent)",
		padding: "8px 12px",
		borderRadius: "4px",
		whiteSpace: "pre-wrap",
	},
	// table / mermaid / display math は Decoration.replace({ block: true }) の block widget
	// で、.cm-line の外 (.cm-content 直下) に render されるため .cm-line の horizontal
	// padding を受けられない。margin で同じインセットを与えてテキスト列と左右を揃える。
	// この rule は .cm-mermaid-widget の margin: "4px 0" shorthand より後 (source order)
	// に置くこと — 前に置くと shorthand に horizontal channel を上書きされる。
	".cm-table-widget, .cm-mermaid-widget, .cm-math-display": {
		marginLeft: "var(--cm-horizontal-padding, 0px)",
		marginRight: "var(--cm-horizontal-padding, 0px)",
	},
	".cm-link-card": {
		display: "block",
		border: "1px solid var(--color-border)",
		borderRadius: "8px",
		padding: "8px 12px",
		maxWidth: "600px",
		cursor: "pointer",
		transition: "background-color 0.15s ease-out",
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
