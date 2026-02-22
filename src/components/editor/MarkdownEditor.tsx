import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { highlightQueryExtension, setHighlightQuery } from "./highlight-query";
import {
	blockquoteDecoration,
	codeBlockDecoration,
	emphasisDecoration,
	headingDecoration,
	horizontalRuleDecoration,
	imageDecoration,
	linkDecoration,
	listDecoration,
	listKeymap,
	strikethroughDecoration,
} from "./live-preview";

const customHighlightStyle = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.heading, fontWeight: "bold" },
		{ tag: tags.link, textDecoration: "none" },
	]),
);

const editorTheme = EditorView.theme({
	"&": {
		height: "100%",
		fontSize: "14px",
		backgroundColor: "var(--color-bg-primary)",
		color: "var(--color-text-primary)",
	},
	".cm-scroller": {
		fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
	},
	".cm-content": {
		caretColor: "var(--color-text-primary)",
		padding: "8px 0",
		fontSynthesis: "style",
	},
	".cm-line": {
		padding: "1px 2px",
	},
	"&.cm-focused .cm-cursor": {
		borderLeftColor: "var(--color-text-primary)",
	},
	".cm-gutters": {
		backgroundColor: "var(--color-bg-secondary)",
		color: "var(--color-text-secondary)",
		borderRight: "1px solid var(--color-border)",
	},
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 25%, transparent)",
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
	".cm-task-checkbox": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: "16px",
		height: "16px",
		borderRadius: "4px",
		border: "1.5px solid var(--color-text-secondary)",
		marginRight: "6px",
		verticalAlign: "middle",
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
		width: "12px",
		height: "12px",
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
		fontSize: "0.85em",
		marginRight: "0.35em",
	},
	".cm-searchMatch": {
		backgroundColor: "color-mix(in srgb, #facc15 30%, transparent)",
	},
	".cm-searchMatch-selected": {
		backgroundColor: "color-mix(in srgb, #f97316 40%, transparent)",
	},
});

const markdownExtension = markdown({ base: markdownLanguage, codeLanguages: languages });
interface GoToLineRequest {
	line: number;
	query?: string;
}

interface MarkdownEditorProps {
	value: string;
	onChange: (value: string) => void;
	onSave: () => void;
	onEditorView?: (view: EditorView | null) => void;
	goToLine?: GoToLineRequest | null;
	onGoToLineDone?: () => void;
}

export function MarkdownEditor({
	value,
	onChange,
	onSave,
	onEditorView,
	goToLine,
	onGoToLineDone,
}: MarkdownEditorProps) {
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const editorRef = useRef<ReactCodeMirrorRef>(null);
	const onEditorViewRef = useRef(onEditorView);
	onEditorViewRef.current = onEditorView;

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
	}, []);

	const handleDestroyEditor = useCallback(() => {
		onEditorViewRef.current?.(null);
	}, []);

	const extensions = useMemo(
		() => [
			listKeymap,
			editorTheme,
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			customHighlightStyle,
			markdownExtension,
			search(),
			highlightQueryExtension,
			headingDecoration,
			emphasisDecoration,
			strikethroughDecoration,
			linkDecoration,
			imageDecoration,
			codeBlockDecoration,
			listDecoration,
			blockquoteDecoration,
			horizontalRuleDecoration,
			keymap.of([
				{
					key: "Mod-s",
					run: () => {
						onSaveRef.current();
						return true;
					},
				},
			]),
		],
		[],
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
						lineNumbers: true,
						foldGutter: true,
						highlightActiveLine: false,
						highlightActiveLineGutter: false,
						bracketMatching: true,
						closeBrackets: true,
						indentOnInput: true,
						searchKeymap: false,
					}}
				/>
			</div>
		</div>
	);
}
