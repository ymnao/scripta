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
import { gotoLine, search } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { ContextMenu } from "../filetree/ContextMenu";
import { MermaidEditorDialog } from "./MermaidEditorDialog";
import { composingClass, createDynamicEditorTheme, staticEditorTheme } from "./editor-theme";
import {
	toggleBold,
	toggleCheckbox,
	toggleHeading,
	toggleItalic,
	toggleList,
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
	mermaidDecoration,
	strikethroughDecoration,
	tableDecoration,
	tableKeymap,
	wikilinkCompletion,
	wikilinkDecoration,
} from "./live-preview";

const customHighlightStyle = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.heading, fontWeight: "bold" },
		{ tag: tags.link, textDecoration: "none" },
	]),
);

/** 内容に含まれるバッククォート数に応じて十分長いフェンスを生成する */
function buildMermaidFence(content: string): string {
	let max = 2;
	for (const m of content.matchAll(/`{3,}/g)) {
		if (m[0].length > max) max = m[0].length;
	}
	return "`".repeat(max + 1);
}

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
	const containerRef = useRef<HTMLDivElement>(null);
	const [mermaidContextMenu, setMermaidContextMenu] = useState<{
		position: { x: number; y: number };
		source: string;
		from: number;
		to: number;
	} | null>(null);
	const [mermaidEditor, setMermaidEditor] = useState<{
		source: string;
		from: number;
		to: number;
	} | null>(null);
	const [mermaidInsertPos, setMermaidInsertPos] = useState<number | null>(null);

	// Cancel any pending statistics RAF on unmount
	useEffect(() => {
		return () => cancelAnimationFrame(statsRafIdRef.current);
	}, []);

	// Listen for mermaid right-click context menu events from CM extension
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onMermaidMenu = (e: Event) => {
			const { source, from, to, clientX, clientY } = (e as CustomEvent).detail;
			setMermaidContextMenu({ position: { x: clientX, y: clientY }, source, from, to });
		};
		el.addEventListener("mermaid-context-menu", onMermaidMenu);
		return () => el.removeEventListener("mermaid-context-menu", onMermaidMenu);
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
			tableKeymap,
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
			mermaidDecoration,
			listDecoration,
			blockquoteDecoration,
			horizontalRuleDecoration,
			mathDecoration,
			tableDecoration,
			...(showLinkCards ? [linkCardDecoration] : []),
			wikilinkCompletion,
			Prec.high(
				keymap.of([
					{ key: "Mod-l", run: toggleList },
					{ key: "Mod-Shift-l", run: toggleCheckbox },
				]),
			),
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
				{ key: "Mod-g", run: gotoLine },
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

	const handleMermaidSave = useCallback(
		(newSource: string) => {
			const view = editorRef.current?.view;
			if (view && mermaidEditor && newSource !== mermaidEditor.source) {
				const fence = buildMermaidFence(newSource);
				const newText = `${fence}mermaid\n${newSource}\n${fence}`;
				view.dispatch({
					changes: { from: mermaidEditor.from, to: mermaidEditor.to, insert: newText },
				});
			}
			setMermaidEditor(null);
		},
		[mermaidEditor],
	);

	const handleMermaidInsert = useCallback(
		(newSource: string) => {
			const view = editorRef.current?.view;
			if (view && mermaidInsertPos !== null && newSource.trim()) {
				const doc = view.state.doc;
				const pos = Math.min(mermaidInsertPos, doc.length);
				const line = doc.lineAt(pos);
				const insertAt = line.to;
				const before = insertAt > 0 ? "\n\n" : "";
				const hasTrailingNewline =
					insertAt < doc.length && doc.sliceString(insertAt, insertAt + 1) === "\n";
				const after = insertAt < doc.length && !hasTrailingNewline ? "\n" : "";
				const fence = buildMermaidFence(newSource);
				const newText = `${before}${fence}mermaid\n${newSource}\n${fence}${after}`;
				view.dispatch({ changes: { from: insertAt, to: insertAt, insert: newText } });
			}
			setMermaidInsertPos(null);
		},
		[mermaidInsertPos],
	);

	return (
		<div ref={containerRef} className="relative min-h-0 min-w-0 flex-1">
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
						drawSelection: true,
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
			{mermaidContextMenu && (
				<ContextMenu
					position={mermaidContextMenu.position}
					items={[
						{
							id: "edit-mermaid",
							label: "Mermaid を編集",
							onClick: () => {
								setMermaidEditor({
									source: mermaidContextMenu.source,
									from: mermaidContextMenu.from,
									to: mermaidContextMenu.to,
								});
							},
						},
						{
							id: "insert-mermaid",
							label: "Mermaid 図を挿入",
							onClick: () => {
								setMermaidInsertPos(mermaidContextMenu.to);
							},
						},
						{
							id: "delete-mermaid-sep",
							label: "",
							separator: true,
							onClick: () => {},
						},
						{
							id: "delete-mermaid",
							label: "Mermaid を削除",
							danger: true,
							onClick: () => {
								const view = editorRef.current?.view;
								if (!view) return;
								const { from, to } = mermaidContextMenu;
								view.dispatch({ changes: { from, to, insert: "" } });
							},
						},
					]}
					onClose={() => setMermaidContextMenu(null)}
				/>
			)}
			<MermaidEditorDialog
				open={mermaidEditor !== null}
				source={mermaidEditor?.source ?? ""}
				onSave={handleMermaidSave}
				onCancel={() => setMermaidEditor(null)}
			/>
			<MermaidEditorDialog
				open={mermaidInsertPos !== null}
				source=""
				mode="insert"
				onSave={handleMermaidInsert}
				onCancel={() => setMermaidInsertPos(null)}
			/>
		</div>
	);
}
