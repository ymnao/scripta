import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";
import { headingDecoration } from "./live-preview";

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
	".cm-activeLine": {
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 8%, transparent)",
	},
	".cm-activeLineGutter": {
		backgroundColor: "color-mix(in srgb, var(--color-text-secondary) 8%, transparent)",
	},
	".cm-heading-1": { fontSize: "1.8em", fontWeight: "700", lineHeight: "1.3" },
	".cm-heading-2": { fontSize: "1.5em", fontWeight: "700", lineHeight: "1.3" },
	".cm-heading-3": { fontSize: "1.25em", fontWeight: "600", lineHeight: "1.3" },
	".cm-heading-4": { fontSize: "1.1em", fontWeight: "600", lineHeight: "1.3" },
	".cm-heading-5": { fontSize: "1em", fontWeight: "600", lineHeight: "1.3" },
	".cm-heading-6": { fontSize: "0.9em", fontWeight: "600", lineHeight: "1.3" },
});

const markdownExtension = markdown({ codeLanguages: languages });

interface MarkdownEditorProps {
	value: string;
	onChange: (value: string) => void;
	onSave: () => void;
}

export function MarkdownEditor({ value, onChange, onSave }: MarkdownEditorProps) {
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;

	const extensions = useMemo(
		() => [
			editorTheme,
			markdownExtension,
			headingDecoration,
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
		<CodeMirror
			value={value}
			onChange={onChange}
			extensions={extensions}
			height="100%"
			theme="none"
			aria-label="Markdown editor"
			basicSetup={{
				lineNumbers: true,
				foldGutter: true,
				highlightActiveLine: true,
				highlightActiveLineGutter: true,
				bracketMatching: true,
				closeBrackets: true,
				indentOnInput: true,
			}}
		/>
	);
}
