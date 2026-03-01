import "katex/dist/katex.min.css";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
	HighlightStyle,
	defaultHighlightStyle,
	foldService,
	indentUnit,
	syntaxHighlighting,
	syntaxTree,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FontFamily } from "../../lib/store";
import { useSettingsStore } from "../../stores/settings";
import {
	toggleBold,
	toggleHeading,
	toggleItalic,
	toggleStrikethrough,
} from "./formatting-commands";
import { highlightQueryExtension, setHighlightQuery } from "./highlight-query";
import {
	blockquoteDecoration,
	codeBlockDecoration,
	emphasisDecoration,
	headingDecoration,
	horizontalRuleDecoration,
	imageDecoration,
	linkCardDecoration,
	linkDecoration,
	listDecoration,
	listKeymap,
	mathDecoration,
	strikethroughDecoration,
	wikilinkCompletion,
	wikilinkDecoration,
} from "./live-preview";

const customHighlightStyle = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.heading, fontWeight: "bold" },
		{ tag: tags.link, textDecoration: "none" },
	]),
);

/**
 * IME コンポジション中にエディタへ cm-composing クラスを付与する。
 * WKWebView では ::selection の背景色がコンポジションテキストに
 * 不正に適用される (WebKit Bug 37788) ため、このクラスで抑制する。
 */
const composingClass = ViewPlugin.fromClass(
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

const FONT_FAMILY_MAP: Record<FontFamily, string> = {
	monospace: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
	"sans-serif": "system-ui, -apple-system, sans-serif",
	serif: "Georgia, 'Times New Roman', serif",
};

function createDynamicEditorTheme(fontSize: number, fontFamily: FontFamily) {
	return EditorView.theme({
		"&": {
			height: "100%",
			fontSize: `${fontSize}px`,
			backgroundColor: "var(--color-bg-primary)",
			color: "var(--color-text-primary)",
		},
		".cm-scroller": {
			fontFamily: FONT_FAMILY_MAP[fontFamily],
		},
		".cm-content": {
			caretColor: "var(--color-text-primary)",
			padding: "8px 16px",
			fontSynthesis: "style",
		},
		".cm-line": {
			padding: "1px 0",
		},
	});
}

const staticEditorTheme = EditorView.theme({
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
	".cm-content ::selection": {
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 25%, transparent)",
	},
	"&.cm-composing .cm-content ::selection": {
		backgroundColor: "transparent",
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
});

const listFoldService = foldService.of((state, lineStart, lineEnd) => {
	const tree = syntaxTree(state);
	let result: { from: number; to: number } | null = null;
	tree.iterate({
		from: lineStart,
		to: lineEnd,
		enter(node) {
			if (result) return false;
			if (node.name !== "ListItem") return;
			const startLine = state.doc.lineAt(node.from);
			if (startLine.from !== lineStart) return false;
			const endLine = state.doc.lineAt(node.to > node.from ? node.to - 1 : node.to);
			if (endLine.number <= startLine.number) return false;
			result = { from: startLine.to, to: endLine.to };
			return false;
		},
	});
	return result;
});

const markdownExtension = markdown({ base: markdownLanguage, codeLanguages: languages });
interface GoToLineRequest {
	line: number;
	query?: string;
}

export interface CursorInfo {
	line: number;
	col: number;
	chars: number;
	selectedChars?: number;
	selectedLines?: number;
}

interface MarkdownEditorProps {
	value: string;
	onChange: (value: string) => void;
	onSave: () => void;
	onEditorView?: (view: EditorView | null) => void;
	goToLine?: GoToLineRequest | null;
	onGoToLineDone?: () => void;
	onStatistics?: (info: CursorInfo) => void;
}

export function MarkdownEditor({
	value,
	onChange,
	onSave,
	onEditorView,
	goToLine,
	onGoToLineDone,
	onStatistics,
}: MarkdownEditorProps) {
	const showLineNumbers = useSettingsStore((s) => s.showLineNumbers);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const highlightActiveLine = useSettingsStore((s) => s.highlightActiveLine);
	const showLinkCards = useSettingsStore((s) => s.showLinkCards);
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const editorRef = useRef<ReactCodeMirrorRef>(null);
	const onEditorViewRef = useRef(onEditorView);
	onEditorViewRef.current = onEditorView;
	const onStatisticsRef = useRef(onStatistics);
	onStatisticsRef.current = onStatistics;
	const statsRafIdRef = useRef(0);

	// Cancel any pending statistics RAF on unmount
	useEffect(() => {
		return () => cancelAnimationFrame(statsRafIdRef.current);
	}, []);

	useEffect(() => {
		if (goToLine == null) return;
		const frame = requestAnimationFrame(() => {
			const view = editorRef.current?.view;
			if (!view) return;
			const lineNum = Math.min(goToLine.line, view.state.doc.lines);
			const lineInfo = view.state.doc.line(lineNum);

			view.dispatch({
				selection: EditorSelection.cursor(lineInfo.from),
				effects: goToLine.query ? [setHighlightQuery.of(goToLine.query)] : [],
			});

			view.dispatch({
				effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
			});

			view.focus();
			onGoToLineDone?.();
		});
		return () => cancelAnimationFrame(frame);
	}, [goToLine, onGoToLineDone]);

	const handleCreateEditor = useCallback((view: EditorView) => {
		onEditorViewRef.current?.(view);
		// Emit initial cursor stats on mount (updateListener only fires on updates)
		const callback = onStatisticsRef.current;
		if (callback) {
			const sel = view.state.selection.main;
			const lineInfo = view.state.doc.lineAt(sel.head);
			callback({
				line: lineInfo.number,
				col: sel.head - lineInfo.from + 1,
				chars: view.state.doc.length,
			});
		}
	}, []);

	const handleDestroyEditor = useCallback(() => {
		onEditorViewRef.current?.(null);
	}, []);

	const extensions = useMemo(
		() => [
			listKeymap,
			composingClass,
			EditorView.lineWrapping,
			staticEditorTheme,
			createDynamicEditorTheme(fontSize, fontFamily),
			indentUnit.of("  "),
			EditorState.tabSize.of(2),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			customHighlightStyle,
			markdownExtension,
			listFoldService,
			search(),
			highlightQueryExtension,
			headingDecoration,
			emphasisDecoration,
			strikethroughDecoration,
			wikilinkDecoration,
			linkDecoration,
			imageDecoration,
			codeBlockDecoration,
			listDecoration,
			blockquoteDecoration,
			horizontalRuleDecoration,
			mathDecoration,
			...(showLinkCards ? [linkCardDecoration] : []),
			wikilinkCompletion,
			keymap.of([
				{
					key: "Mod-s",
					run: () => {
						onSaveRef.current();
						return true;
					},
				},
				{ key: "Mod-b", run: toggleBold },
				{ key: "Mod-i", run: toggleItalic },
				{ key: "Mod-Shift-x", run: toggleStrikethrough },
				{ key: "Mod-1", run: toggleHeading(1) },
				{ key: "Mod-2", run: toggleHeading(2) },
				{ key: "Mod-3", run: toggleHeading(3) },
				{ key: "Mod-4", run: toggleHeading(4) },
				{ key: "Mod-5", run: toggleHeading(5) },
				{ key: "Mod-6", run: toggleHeading(6) },
			]),
			EditorView.updateListener.of((update) => {
				if (!(update.docChanged || update.selectionSet)) return;
				const callback = onStatisticsRef.current;
				if (!callback) return;
				cancelAnimationFrame(statsRafIdRef.current);
				statsRafIdRef.current = requestAnimationFrame(() => {
					const sel = update.state.selection.main;
					const lineInfo = update.state.doc.lineAt(sel.head);
					const info: CursorInfo = {
						line: lineInfo.number,
						col: sel.head - lineInfo.from + 1,
						chars: update.state.doc.length,
					};
					if (!sel.empty) {
						info.selectedChars = update.state.sliceDoc(sel.from, sel.to).length;
						const fromLine = update.state.doc.lineAt(sel.from).number;
						const toLine = update.state.doc.lineAt(sel.to).number;
						info.selectedLines = toLine - fromLine + 1;
					}
					callback(info);
				});
			}),
		],
		[fontSize, fontFamily, showLinkCards],
	);

	return (
		<div className="relative min-h-0 min-w-0 flex-1">
			<div className="absolute inset-0">
				<CodeMirror
					ref={editorRef}
					className="h-full"
					value={value}
					onChange={onChange}
					extensions={extensions}
					height="100%"
					theme="none"
					aria-label="Markdown editor"
					onCreateEditor={handleCreateEditor}
					onDestroyEditor={handleDestroyEditor}
					basicSetup={{
						lineNumbers: showLineNumbers,
						foldGutter: true,
						// ::selection CSS で選択範囲スタイルを制御するため標準の描画を無効化
						drawSelection: false,
						// 検索ハイライトは highlightQueryExtension で制御するため無効化
						highlightSelectionMatches: false,
						// Markdown エディタとしてシンプルな入力体験を優先するため無効化
						autocompletion: false,
						highlightActiveLine,
						highlightActiveLineGutter: true,
						// タスクマーカー [] やリンク [text](url) 等の Markdown 構文で
						// 不要なブラケットハイライトが出るため無効化
						bracketMatching: false,
						closeBrackets: true,
						indentOnInput: true,
						searchKeymap: false,
					}}
				/>
			</div>
		</div>
	);
}
