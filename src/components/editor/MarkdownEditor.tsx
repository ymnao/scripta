import "katex/dist/katex.min.css";
import { redo, undo } from "@codemirror/commands";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
	defaultHighlightStyle,
	foldService,
	indentUnit,
	syntaxHighlighting,
	syntaxTree,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search } from "@codemirror/search";
import { EditorSelection, EditorState, Prec, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { openExternal } from "../../lib/commands";
import { buildFence } from "../../lib/export";
import { IS_MAC, PRIMARY_MOD_SYMBOL } from "../../lib/platform";
import { useSettingsStore } from "../../stores/settings";
import { Dialog } from "../common/Dialog";
import type { ContextMenuItem } from "../filetree/ContextMenu";
import { ContextMenu } from "../filetree/ContextMenu";
import { codeHighlightStyle, createDynamicEditorTheme, staticEditorTheme } from "./editor-theme";
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
	buildMarkdownLink,
	codeBlockCopyDecoration,
	codeBlockDecoration,
	emphasisDecoration,
	getCardDeleteRange,
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
	pasteAsMarkdownLinkCommand,
	strikethroughDecoration,
	tableDecoration,
	tableKeymap,
	wikilinkCompletion,
	wikilinkDecoration,
	wikilinkHoverTooltip,
} from "./live-preview";
import { MermaidEditorDialog } from "./MermaidEditorDialog";

/**
 * Mouse event の target を Element に正規化する小ヘルパー。
 * Text node なら parentElement、それ以外は null。`handleEditorMouseDown` /
 * `handleEditorContextMenu` の冒頭で重複していた if-cascade を 1 箇所に集約。
 */
function resolveTargetElement(target: EventTarget | null): Element | null {
	if (target instanceof Element) return target;
	if (target instanceof Node) return target.parentElement;
	return null;
}

/**
 * CM extension が `view.dom.dispatchEvent(new CustomEvent(name, {detail}))` で
 * 投げてくる widget 系右クリックメニュー event を React state に橋渡しする hook。
 * mermaid / link-card / link-widget の 3 つで同じ useEffect コピペが重複していた。
 *
 * `onEvent` の最新版を ref で参照することで listener 登録は 1 回のみに保ち、
 * stale closure も避ける。
 */
function useWidgetCustomEvent<T>(
	containerRef: React.RefObject<HTMLElement | null>,
	eventName: string,
	onEvent: (detail: T) => void,
): void {
	const handlerRef = useRef(onEvent);
	handlerRef.current = onEvent;
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const handler = (e: Event) => handlerRef.current((e as CustomEvent<T>).detail);
		el.addEventListener(eventName, handler);
		return () => el.removeEventListener(eventName, handler);
	}, [containerRef, eventName]);
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
export interface GoToLineRequest {
	line: number;
	query?: string;
	// 行内の UTF-16 code unit オフセット。検索結果からのナビゲーションで指定する。
	// 同一行に複数マッチがあるとき、列位置がないとどの結果も同じ場所に飛ぶ。
	columnStart?: number;
	columnEnd?: number;
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
	const [cardContextMenu, setCardContextMenu] = useState<{
		position: { x: number; y: number };
		url: string;
		lineFrom: number;
		lineTo: number;
	} | null>(null);
	const [linkWidgetContextMenu, setLinkWidgetContextMenu] = useState<{
		position: { x: number; y: number };
		url: string;
		label: string;
		from: number;
		to: number;
		isUrlOnlyLine: boolean;
	} | null>(null);
	const [linkConvertConfirm, setLinkConvertConfirm] = useState<{
		url: string;
		label: string;
		from: number;
		to: number;
	} | null>(null);
	// 右クリック mousedown 前の選択状態を保持。
	// mousedown → mousemove による意図しないマイクロ選択を無視するために使用
	const preRightClickSelRef = useRef<{ from: number; to: number } | null>(null);

	// Cancel any pending statistics RAF on unmount
	useEffect(() => {
		return () => cancelAnimationFrame(statsRafIdRef.current);
	}, []);

	// Widget 右クリックメニューイベント 3 系統を共通 hook で配線
	useWidgetCustomEvent<{
		source: string;
		from: number;
		to: number;
		clientX: number;
		clientY: number;
	}>(containerRef, "mermaid-context-menu", ({ source, from, to, clientX, clientY }) => {
		setMermaidContextMenu({ position: { x: clientX, y: clientY }, source, from, to });
	});

	useWidgetCustomEvent<{
		url: string;
		lineFrom: number;
		lineTo: number;
		clientX: number;
		clientY: number;
	}>(containerRef, "link-card-context-menu", ({ url, lineFrom, lineTo, clientX, clientY }) => {
		setCardContextMenu({ position: { x: clientX, y: clientY }, url, lineFrom, lineTo });
	});

	useWidgetCustomEvent<{
		url: string;
		label: string;
		from: number;
		to: number;
		isUrlOnlyLine: boolean;
		clientX: number;
		clientY: number;
	}>(
		containerRef,
		"link-widget-context-menu",
		({ url, label, from, to, isUrlOnlyLine, clientX, clientY }) => {
			setLinkWidgetContextMenu({
				position: { x: clientX, y: clientY },
				url,
				label,
				from,
				to,
				isUrlOnlyLine,
			});
		},
	);

	useEffect(() => {
		if (goToLine == null) return;
		const frame = requestAnimationFrame(() => {
			const view = editorRef.current?.view;
			if (!view) return;
			const lineNum = Math.min(goToLine.line, view.state.doc.lines);
			const lineInfo = view.state.doc.line(lineNum);

			let selection: SelectionRange;
			if (goToLine.columnStart != null && goToLine.columnEnd != null) {
				// 検索結果からのナビゲーション: 行内の正確な範囲を選択する。
				// ファイルが変更されてマッチが消えた場合に備えて lineInfo の範囲に clamp。
				const start = lineInfo.from + Math.min(goToLine.columnStart, lineInfo.length);
				const end = lineInfo.from + Math.min(goToLine.columnEnd, lineInfo.length);
				selection = EditorSelection.range(start, end);
			} else {
				const pos = goToLine.query ? lineInfo.from : lineInfo.to;
				selection = EditorSelection.cursor(pos);
			}
			const head = selection.head;

			view.dispatch({
				selection,
				effects: goToLine.query ? [setHighlightQuery.of(goToLine.query)] : [],
			});

			view.dispatch({
				effects: EditorView.scrollIntoView(head, { y: "center" }),
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
			EditorView.lineWrapping,
			staticEditorTheme,
			createDynamicEditorTheme(fontSize),
			indentUnit.of("  "),
			EditorState.tabSize.of(2),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			codeHighlightStyle,
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
			codeBlockCopyDecoration,
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
					// リスト/タスク/順序付きリスト/blockquote 上の Enter でマーカーを継続。
					// 非 Markdown 文脈（コードブロック等）では false を返して既定の改行に委譲。
					// Backspace 継続は listKeymap の独自ハンドラが担うため deleteMarkupBackward は導入しない。
					{ key: "Enter", run: insertNewlineContinueMarkup },
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
				// clipboard の URL を強制的に md リンクとして貼り付け。
				// 非 URL なら plain insert、コードブロック内も plain。
				{ key: "Mod-Shift-v", run: pasteAsMarkdownLinkCommand },
			]),
			EditorView.updateListener.of((update) => {
				if (!(update.docChanged || update.selectionSet)) return;
				const callback = onStatisticsRef.current;
				if (!callback) return;
				cancelAnimationFrame(statsRafIdRef.current);
				const docLen = update.state.doc.length;
				statsRafIdRef.current = requestAnimationFrame(() => {
					const sel = update.state.selection.main;
					const lineInfo = update.state.doc.lineAt(sel.head);
					const info: CursorInfo = {
						line: lineInfo.number,
						col: sel.head - lineInfo.from + 1,
						chars: docLen,
					};
					if (!sel.empty) {
						info.selectedChars = sel.to - sel.from;
						const fromLine = update.state.doc.lineAt(sel.from).number;
						const toLine = update.state.doc.lineAt(sel.to).number;
						info.selectedLines = toLine - fromLine + 1;
					}
					callback(info);
				});
			}),
		],
		[fontSize, showLinkCards],
	);

	const handleEditorMouseDown = useCallback((e: ReactMouseEvent) => {
		if (e.button !== 2) return;
		const target = resolveTargetElement(e.target);
		if (!target) return;
		// Mermaid・テーブルセル上の右クリック mousedown を阻止して
		// カーソル移動によるデコレーション消失を防ぐ
		if (target.closest(".cm-mermaid-widget") || target.closest(".cm-table-cell")) {
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
		const target = resolveTargetElement(e.target);
		if (!target) return;
		// Mermaid・テーブルセル・OGP カード・md リンク widget は各専用メニューに委譲
		if (
			target.closest(".cm-mermaid-widget") ||
			target.closest(".cm-table-cell") ||
			target.closest(".cm-link-card") ||
			target.closest(".cm-link-widget")
		)
			return;
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
			shortcut: `${PRIMARY_MOD_SYMBOL}V`,
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
				shortcut: `${PRIMARY_MOD_SYMBOL}Z`,
				onClick: withFocus(undo),
			},
			{
				id: "redo",
				label: "やり直す",
				shortcut: IS_MAC ? "⇧⌘Z" : "Ctrl+Y",
				onClick: withFocus(redo),
			},
		];

		if (hasSelection) {
			return [
				{
					id: "cut",
					label: "切り取り",
					shortcut: `${PRIMARY_MOD_SYMBOL}X`,
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
					shortcut: `${PRIMARY_MOD_SYMBOL}C`,
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
					shortcut: `${PRIMARY_MOD_SYMBOL}B`,
					onClick: withFocus(toggleBold),
				},
				{
					id: "italic",
					label: "斜体",
					shortcut: `${PRIMARY_MOD_SYMBOL}I`,
					onClick: withFocus(toggleItalic),
				},
				{
					id: "strikethrough",
					label: "取り消し線",
					shortcut: IS_MAC ? "⇧⌘X" : "Ctrl+Shift+X",
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
				shortcut: IS_MAC ? "⇧⌘T" : "Ctrl+Shift+T",
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

	const getLinkWidgetMenuItems = useCallback((): ContextMenuItem[] => {
		if (!linkWidgetContextMenu) return [];
		const { url, label, from, to, isUrlOnlyLine } = linkWidgetContextMenu;
		const items: ContextMenuItem[] = [
			{
				id: "open-md-link",
				label: "リンクを開く",
				shortcut: `${PRIMARY_MOD_SYMBOL}クリック`,
				onClick: () => {
					openExternal(url).catch((error) => {
						console.error("Failed to open URL:", url, error);
					});
				},
			},
			{
				id: "copy-md-link-url",
				label: "URL をコピー",
				onClick: () => {
					if (!navigator.clipboard) return;
					navigator.clipboard.writeText(url).catch(() => {});
				},
			},
		];
		if (isUrlOnlyLine) {
			items.push({
				id: "make-card",
				label: "カードにする",
				onClick: () => {
					// label が URL と一致するなら直接変換、違うなら confirm dialog 経由
					if (label.trim() === url.trim()) {
						const view = editorRef.current?.view;
						if (!view) return;
						view.dispatch({ changes: { from, to, insert: url } });
						view.focus();
					} else {
						setLinkConvertConfirm({ url, label, from, to });
					}
				},
			});
		}
		return items;
	}, [linkWidgetContextMenu]);

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
		<section
			ref={containerRef}
			aria-label="Editor"
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
			{linkWidgetContextMenu && (
				<ContextMenu
					position={linkWidgetContextMenu.position}
					items={getLinkWidgetMenuItems()}
					onClose={() => setLinkWidgetContextMenu(null)}
				/>
			)}
			<Dialog
				open={linkConvertConfirm !== null}
				title="md リンクをカードに変換"
				description={
					linkConvertConfirm
						? `表示テキスト「${linkConvertConfirm.label}」が URL と異なります。カードに変換すると表示テキストは捨てられます。続行しますか？`
						: ""
				}
				confirmLabel="変換する"
				cancelLabel="キャンセル"
				variant="danger"
				onConfirm={() => {
					if (!linkConvertConfirm) return;
					const { url, from, to } = linkConvertConfirm;
					const view = editorRef.current?.view;
					if (view) {
						view.dispatch({ changes: { from, to, insert: url } });
						view.focus();
					}
					setLinkConvertConfirm(null);
				}}
				onCancel={() => setLinkConvertConfirm(null)}
			/>
			{cardContextMenu && (
				<ContextMenu
					position={cardContextMenu.position}
					items={[
						{
							id: "open-card",
							label: "リンクを開く",
							onClick: () => {
								openExternal(cardContextMenu.url).catch((error) => {
									console.error("Failed to open URL:", cardContextMenu.url, error);
								});
							},
						},
						{
							id: "copy-card-url",
							label: "URL をコピー",
							onClick: () => {
								if (!navigator.clipboard) return;
								navigator.clipboard.writeText(cardContextMenu.url).catch(() => {});
							},
						},
						{
							id: "convert-card-to-md",
							label: "md リンクに変換",
							onClick: () => {
								const view = editorRef.current?.view;
								if (!view) return;
								// label も URL を使う lossless 変換: `[url](<url>)`
								const insert = buildMarkdownLink(cardContextMenu.url, "");
								view.dispatch({
									changes: {
										from: cardContextMenu.lineFrom,
										to: cardContextMenu.lineTo,
										insert,
									},
								});
								view.focus();
							},
						},
						{
							id: "delete-card-sep",
							label: "",
							separator: true,
							onClick: () => {},
						},
						{
							id: "delete-card",
							label: "カードを削除",
							danger: true,
							onClick: () => {
								const view = editorRef.current?.view;
								if (!view) return;
								const range = getCardDeleteRange(view.state.doc, cardContextMenu.lineFrom);
								view.dispatch({ changes: { from: range.from, to: range.to, insert: "" } });
								view.focus();
							},
						},
					]}
					onClose={() => setCardContextMenu(null)}
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
		</section>
	);
}
