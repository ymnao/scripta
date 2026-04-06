import "katex/dist/katex.min.css";
import { redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
	defaultHighlightStyle,
	foldService,
	HighlightStyle,
	indentUnit,
	syntaxHighlighting,
	syntaxTree,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search } from "@codemirror/search";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { buildFence } from "../../lib/export";
import { useSettingsStore } from "../../stores/settings";
import type { ContextMenuItem } from "../filetree/ContextMenu";
import { ContextMenu } from "../filetree/ContextMenu";
import { composingClass, createDynamicEditorTheme, staticEditorTheme } from "./editor-theme";
import {
	insertHorizontalRule,
	toggleBold,
	toggleCheckbox,
	toggleCheckState,
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
	insertTable,
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
	wikilinkHoverTooltip,
} from "./live-preview";
import { MermaidEditorDialog } from "./MermaidEditorDialog";

const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");

const customHighlightStyle = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.heading, fontWeight: "bold" },
		{ tag: tags.link, textDecoration: "none" },
	]),
);

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
export interface GoToLineRequest {
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
	const [editorContextMenu, setEditorContextMenu] = useState<{
		position: { x: number; y: number };
	} | null>(null);
	// 右クリック mousedown 前の選択状態を保持。
	// mousedown → mousemove による意図しないマイクロ選択を無視するために使用
	const preRightClickSelRef = useRef<{ from: number; to: number } | null>(null);

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

			const pos = goToLine.query ? lineInfo.from : lineInfo.to;

			view.dispatch({
				selection: EditorSelection.cursor(pos),
				effects: goToLine.query ? [setHighlightQuery.of(goToLine.query)] : [],
			});

			view.dispatch({
				effects: EditorView.scrollIntoView(pos, { y: "center" }),
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

	// Notify parent when the editor is destroyed (unmounted).
	// Cannot use onDestroyEditor prop — it is not in @uiw/react-codemirror's
	// type definitions and React warns about the unknown DOM event handler.
	useEffect(() => {
		return () => onEditorViewRef.current?.(null);
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
			wikilinkHoverTooltip,
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
					{ key: "Mod-Enter", run: toggleCheckState },
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

	const handleEditorMouseDown = useCallback((e: ReactMouseEvent) => {
		if (e.button !== 2) return;
		const target = e.target as HTMLElement;
		// Mermaid・テーブルウィジェット上の右クリック mousedown を阻止して
		// カーソル移動によるデコレーション消失を防ぐ
		if (target.closest(".cm-mermaid-widget") || target.closest(".cm-table-widget")) {
			e.preventDefault();
			return;
		}
		// 右クリック前の選択状態を保存（mousedown → mousemove による
		// マイクロ選択を contextmenu ハンドラで無視するため）
		const view = editorRef.current?.view;
		if (view) {
			const sel = view.state.selection.main;
			preRightClickSelRef.current = { from: sel.from, to: sel.to };
		}
	}, []);

	const handleEditorContextMenu = useCallback((e: ReactMouseEvent) => {
		const target = e.target as HTMLElement;
		// Mermaid・テーブルウィジェット上のクリックは既存メニューに委譲
		if (target.closest(".cm-mermaid-widget") || target.closest(".cm-table-widget")) return;
		// 他のハンドラが既に処理済みなら何もしない
		if (e.defaultPrevented) return;
		e.preventDefault();
		const view = editorRef.current?.view;
		if (!view) return;

		// 右クリック位置にカーソルを移動。
		// mousedown 前に存在した選択範囲内ならその選択を維持
		const clickPos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.doc.length;
		const pre = preRightClickSelRef.current;
		// pre が null の場合は mousedown が発火しなかったケース（テスト等）→ 現在の選択を参照
		const sel = pre ?? { from: view.state.selection.main.from, to: view.state.selection.main.to };
		const hadSelection = sel.from !== sel.to;
		if (hadSelection && clickPos >= sel.from && clickPos <= sel.to) {
			// mousedown でマイクロ選択が発生していた場合は元の選択を復元
			if (pre) view.dispatch({ selection: EditorSelection.range(pre.from, pre.to) });
		} else {
			view.dispatch({ selection: EditorSelection.cursor(clickPos) });
		}
		preRightClickSelRef.current = null;

		setEditorContextMenu({ position: { x: e.clientX, y: e.clientY } });
	}, []);

	const getEditorContextMenuItems = useCallback((): ContextMenuItem[] => {
		if (!editorContextMenu) return [];
		const view = editorRef.current?.view;
		if (!view) return [];
		const hasSelection = !view.state.selection.main.empty;
		const sep = (id: string): ContextMenuItem => ({
			id,
			label: "",
			separator: true,
			onClick: () => {},
		});
		const withFocus = (cmd: (v: EditorView) => unknown) => () => {
			cmd(view);
			view.focus();
		};

		// ── 共通項目: 貼り付け / 元に戻す / やり直す ──
		const pasteItem: ContextMenuItem = {
			id: "paste",
			label: "貼り付け",
			shortcut: `${isMac ? "⌘" : "Ctrl+"}V`,
			onClick: () => {
				if (!navigator.clipboard) return;
				navigator.clipboard.readText().then(
					(text) => {
						const s = view.state.selection.main;
						view.dispatch({ changes: { from: s.from, to: s.to, insert: text } });
						view.focus();
					},
					() => {},
				);
			},
		};
		const undoRedoItems: ContextMenuItem[] = [
			{
				id: "undo",
				label: "元に戻す",
				shortcut: `${isMac ? "⌘" : "Ctrl+"}Z`,
				onClick: withFocus(undo),
			},
			{
				id: "redo",
				label: "やり直す",
				shortcut: isMac ? "⇧⌘Z" : "Ctrl+Y",
				onClick: withFocus(redo),
			},
		];

		if (hasSelection) {
			return [
				{
					id: "cut",
					label: "切り取り",
					shortcut: `${isMac ? "⌘" : "Ctrl+"}X`,
					onClick: () => {
						if (!navigator.clipboard) return;
						const s = view.state.selection.main;
						const text = view.state.sliceDoc(s.from, s.to);
						navigator.clipboard.writeText(text).then(
							() => {
								view.dispatch({ changes: { from: s.from, to: s.to, insert: "" } });
								view.focus();
							},
							() => {},
						);
					},
				},
				{
					id: "copy",
					label: "コピー",
					shortcut: `${isMac ? "⌘" : "Ctrl+"}C`,
					onClick: () => {
						if (!navigator.clipboard) return;
						const s = view.state.selection.main;
						navigator.clipboard.writeText(view.state.sliceDoc(s.from, s.to)).then(
							() => {},
							() => {},
						);
						view.focus();
					},
				},
				pasteItem,
				sep("sep-1"),
				...undoRedoItems,
				sep("sep-2"),
				{
					id: "bold",
					label: "太字",
					shortcut: `${isMac ? "⌘" : "Ctrl+"}B`,
					onClick: withFocus(toggleBold),
				},
				{
					id: "italic",
					label: "斜体",
					shortcut: `${isMac ? "⌘" : "Ctrl+"}I`,
					onClick: withFocus(toggleItalic),
				},
				{
					id: "strikethrough",
					label: "取り消し線",
					shortcut: isMac ? "⇧⌘X" : "Ctrl+Shift+X",
					onClick: withFocus(toggleStrikethrough),
				},
			];
		}

		return [
			pasteItem,
			sep("sep-1"),
			...undoRedoItems,
			sep("sep-2"),
			{
				id: "insert-table",
				label: "テーブルを挿入",
				shortcut: isMac ? "⌃⇧T" : "Alt+Shift+T",
				onClick: withFocus(insertTable),
			},
			{ id: "insert-hr", label: "水平線を挿入", onClick: withFocus(insertHorizontalRule) },
			{
				id: "insert-mermaid",
				label: "Mermaid 図を挿入",
				onClick: () => setMermaidInsertPos(view.state.selection.main.head),
			},
		];
	}, [editorContextMenu]);

	const handleMermaidSave = useCallback(
		(newSource: string) => {
			const view = editorRef.current?.view;
			if (view && mermaidEditor && newSource !== mermaidEditor.source) {
				const fence = buildFence(newSource);
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
				const fence = buildFence(newSource);
				const newText = `${before}${fence}mermaid\n${newSource}\n${fence}${after}`;
				view.dispatch({ changes: { from: insertAt, to: insertAt, insert: newText } });
			}
			setMermaidInsertPos(null);
		},
		[mermaidInsertPos],
	);

	return (
		<div
			ref={containerRef}
			className="relative min-h-0 min-w-0 flex-1"
			onMouseDown={handleEditorMouseDown}
			onContextMenu={handleEditorContextMenu}
		>
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
			{editorContextMenu && (
				<ContextMenu
					position={editorContextMenu.position}
					items={getEditorContextMenuItems()}
					onClose={() => setEditorContextMenu(null)}
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
