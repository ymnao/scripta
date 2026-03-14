import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
	HighlightStyle,
	defaultHighlightStyle,
	indentUnit,
	syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { ArrowUpFromLine, GripHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { readFile } from "../../lib/commands";
import { getScratchpadPath } from "../../lib/scripta-config";
import { useSettingsStore } from "../../stores/settings";
import { composingClass, createDynamicEditorTheme, staticEditorTheme } from "./editor-theme";
import {
	blockquoteDecoration,
	codeBlockDecoration,
	emphasisDecoration,
	headingDecoration,
	horizontalRuleDecoration,
	linkDecoration,
	listDecoration,
	listKeymap,
	mathDecoration,
	strikethroughDecoration,
} from "./live-preview";

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 200;

const customHighlightStyle = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.heading, fontWeight: "bold" },
		{ tag: tags.link, textDecoration: "none" },
	]),
);

const markdownExtension = markdown({ base: markdownLanguage, codeLanguages: languages });

interface ScratchpadPanelProps {
	workspacePath: string;
	onClose: () => void;
	mainEditorView: EditorView | null;
}

export function ScratchpadPanel({ workspacePath, onClose, mainEditorView }: ScratchpadPanelProps) {
	const fontSize = useSettingsStore((s) => s.fontSize);
	const fontFamily = useSettingsStore((s) => s.fontFamily);

	const [content, setContent] = useState("");
	const [height, setHeight] = useState(DEFAULT_HEIGHT);
	const [loaded, setLoaded] = useState(false);
	const editorRef = useRef<ReactCodeMirrorRef>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const draggingRef = useRef(false);
	const startYRef = useRef(0);
	const startHeightRef = useRef(0);

	const scratchpadPath = getScratchpadPath(workspacePath);

	const { saveNow, markSaved } = useAutoSave(scratchpadPath, content);

	// Save content on unmount (covers all close paths: button, Cmd+J, workspace switch)
	const saveNowRef = useRef(saveNow);
	saveNowRef.current = saveNow;
	useEffect(() => {
		return () => {
			void saveNowRef.current();
		};
	}, []);

	// Load scratchpad content on mount
	useEffect(() => {
		let cancelled = false;
		readFile(scratchpadPath)
			.then((loaded) => {
				if (cancelled) return;
				setContent(loaded);
				markSaved(loaded);
				setLoaded(true);
			})
			.catch(() => {
				if (cancelled) return;
				setContent("");
				markSaved("");
				setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [scratchpadPath, markSaved]);

	// Resize handlers
	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		draggingRef.current = true;
		startYRef.current = e.clientY;
		startHeightRef.current = panelRef.current?.offsetHeight ?? DEFAULT_HEIGHT;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	}, []);

	const handlePointerMove = useCallback((e: React.PointerEvent) => {
		if (!draggingRef.current) return;
		const delta = startYRef.current - e.clientY;
		const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeightRef.current + delta));
		setHeight(newHeight);
	}, []);

	const handlePointerUp = useCallback(() => {
		draggingRef.current = false;
	}, []);

	// Insert selected text into main editor
	const handleInsertToMain = useCallback(() => {
		if (!mainEditorView) return;
		const view = editorRef.current?.view;
		if (!view) return;

		const sel = view.state.selection.main;
		if (sel.empty) return;

		const selectedText = view.state.sliceDoc(sel.from, sel.to);
		const mainSel = mainEditorView.state.selection.main;

		mainEditorView.dispatch({
			changes: { from: mainSel.from, to: mainSel.to, insert: selectedText },
		});

		// Remove from scratchpad
		view.dispatch({
			changes: { from: sel.from, to: sel.to, insert: "" },
		});

		mainEditorView.focus();
	}, [mainEditorView]);

	const extensions = useMemo(
		() => [
			listKeymap,
			composingClass,
			EditorView.lineWrapping,
			staticEditorTheme,
			createDynamicEditorTheme(fontSize, fontFamily, "4px 12px"),
			indentUnit.of("  "),
			EditorState.tabSize.of(2),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			customHighlightStyle,
			markdownExtension,
			headingDecoration,
			emphasisDecoration,
			strikethroughDecoration,
			linkDecoration,
			codeBlockDecoration,
			listDecoration,
			blockquoteDecoration,
			horizontalRuleDecoration,
			mathDecoration,
			keymap.of([
				{
					key: "Mod-s",
					run: () => {
						void saveNow();
						return true;
					},
				},
			]),
		],
		[fontSize, fontFamily, saveNow],
	);

	if (!loaded) return null;

	return (
		<div
			ref={panelRef}
			className="flex flex-col border-t border-border"
			style={{ height: `${height}px` }}
			data-testid="scratchpad-panel"
		>
			{/* Resize handle */}
			<div
				className="flex h-6 shrink-0 cursor-row-resize items-center justify-center hover:bg-bg-secondary"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
			>
				<GripHorizontal size={14} className="text-text-secondary" />
			</div>

			{/* Header */}
			<div className="flex shrink-0 items-center justify-between px-3 pb-1">
				<span className="text-xs font-medium text-text-secondary">スクラッチパッド</span>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={handleInsertToMain}
						disabled={!mainEditorView}
						className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-secondary hover:bg-black/10 disabled:opacity-30 dark:hover:bg-white/10"
						title="選択テキストをメインエディタに挿入"
						aria-label="メインエディタに挿入"
					>
						<ArrowUpFromLine size={12} />
					</button>
					<button
						type="button"
						onClick={onClose}
						className="rounded p-0.5 text-text-secondary hover:bg-black/10 dark:hover:bg-white/10"
						aria-label="スクラッチパッドを閉じる"
					>
						<X size={14} />
					</button>
				</div>
			</div>

			{/* Editor */}
			<div className="min-h-0 flex-1">
				<CodeMirror
					ref={editorRef}
					className="h-full"
					value={content}
					onChange={setContent}
					extensions={extensions}
					height="100%"
					theme="none"
					aria-label="Scratchpad editor"
					basicSetup={{
						lineNumbers: false,
						foldGutter: false,
						drawSelection: true,
						highlightSelectionMatches: false,
						autocompletion: false,
						highlightActiveLine: false,
						highlightActiveLineGutter: false,
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
