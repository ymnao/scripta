import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { GripHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { readFile } from "../../lib/commands";
import { getScratchpadPath } from "../../lib/scripta-config";
import { useSettingsStore } from "../../stores/settings";
import {
	codeHighlightStyle,
	composingClass,
	createDynamicEditorTheme,
	staticEditorTheme,
} from "./editor-theme";
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

/**
 * Module-level cache to bridge unmount→remount race.
 * When the panel unmounts, the async save may still be in-flight.
 * If the panel remounts before that save completes, readFile() would
 * return stale disk content.
 *
 * `content` is the latest editor text (what the user sees).
 * `savedContent` is the last content confirmed on disk (from getLastSavedContent).
 * On remount we restore content for the editor but tell useAutoSave
 * only about savedContent, so a failed save is retried automatically.
 */
interface ScratchpadCacheEntry {
	content: string;
	savedContent: string;
}
export const scratchpadContentCache = new Map<string, ScratchpadCacheEntry>();

const markdownExtension = markdown({ base: markdownLanguage, codeLanguages: languages });

export type ScratchpadSaveHandle = () => Promise<boolean>;

interface ScratchpadPanelProps {
	workspacePath: string;
	onClose: () => void;
	saveRef?: React.RefObject<ScratchpadSaveHandle | null>;
}

export function ScratchpadPanel({ workspacePath, onClose, saveRef }: ScratchpadPanelProps) {
	const fontSize = useSettingsStore((s) => s.fontSize);

	const [content, setContent] = useState("");
	const [height, setHeight] = useState(DEFAULT_HEIGHT);
	const [loaded, setLoaded] = useState(false);
	const editorRef = useRef<ReactCodeMirrorRef>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const draggingRef = useRef(false);
	const startYRef = useRef(0);
	const startHeightRef = useRef(0);

	const scratchpadPath = getScratchpadPath(workspacePath);

	const isEditorComposing = useCallback(() => editorRef.current?.view?.composing ?? false, []);
	const { saveStatus, saveNow, markSaved, getLastSavedContent } = useAutoSave(
		scratchpadPath,
		content,
		isEditorComposing,
	);

	// Ref so handleChange can read the latest savedContent without a dep on getLastSavedContent
	const getLastSavedContentRef = useRef(getLastSavedContent);
	getLastSavedContentRef.current = getLastSavedContent;

	// Keep content cache in sync on every change.
	// If the entry was deleted (e.g. by volatile archive clearing the cache),
	// re-create it so a subsequent close→reopen still finds the latest content.
	const handleChange = useCallback(
		(value: string) => {
			setContent(value);
			const entry = scratchpadContentCache.get(scratchpadPath);
			if (entry) {
				entry.content = value;
			} else {
				scratchpadContentCache.set(scratchpadPath, {
					content: value,
					savedContent: getLastSavedContentRef.current(),
				});
			}
		},
		[scratchpadPath],
	);

	// Expose saveNow to parent via ref (for window close handling)
	const saveNowRef = useRef(saveNow);
	saveNowRef.current = saveNow;
	useEffect(() => {
		if (saveRef) {
			saveRef.current = () => saveNowRef.current();
		}
		return () => {
			// Start save and keep saveRef pointing to the pending promise
			// so onCloseRequested can await it even after unmount.
			const promise = saveNowRef.current();
			if (saveRef) {
				saveRef.current = () => promise;
			}
		};
	}, [saveRef]);

	// Keep cache savedContent in sync when saves succeed.
	// getLastSavedContent() reads a ref directly so it always returns
	// the actual processed content on disk, regardless of render timing.
	useEffect(() => {
		if (saveStatus === "saved") {
			const entry = scratchpadContentCache.get(scratchpadPath);
			if (entry) {
				entry.savedContent = getLastSavedContent();
			}
		}
	}, [saveStatus, scratchpadPath, getLastSavedContent]);

	// Load scratchpad content on mount.
	// Prefer in-memory cache to avoid reading stale disk content
	// when the panel is closed and immediately reopened (the previous
	// unmount's async save may still be in-flight).
	// markSaved receives savedContent (confirmed on disk), NOT content,
	// so a failed previous save is detected as a diff and retried.
	useEffect(() => {
		const cached = scratchpadContentCache.get(scratchpadPath);
		if (cached !== undefined) {
			setContent(cached.content);
			markSaved(cached.savedContent);
			setLoaded(true);
			return;
		}

		let cancelled = false;
		readFile(scratchpadPath)
			.then((loaded) => {
				if (cancelled) return;
				setContent(loaded);
				scratchpadContentCache.set(scratchpadPath, { content: loaded, savedContent: loaded });
				markSaved(loaded);
				setLoaded(true);
			})
			.catch(() => {
				if (cancelled) return;
				setContent("");
				scratchpadContentCache.set(scratchpadPath, { content: "", savedContent: "" });
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

	// Focus editor and move cursor to end of document after load
	useEffect(() => {
		if (!loaded) return;
		requestAnimationFrame(() => {
			const view = editorRef.current?.view;
			if (!view) return;
			const end = view.state.doc.length;
			view.dispatch({ selection: { anchor: end } });
			view.focus();
		});
	}, [loaded]);

	const extensions = useMemo(
		() => [
			listKeymap,
			composingClass,
			EditorView.lineWrapping,
			staticEditorTheme,
			createDynamicEditorTheme(fontSize, "4px 12px"),
			indentUnit.of("  "),
			EditorState.tabSize.of(2),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			codeHighlightStyle,
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
		[fontSize, saveNow],
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
				<button
					type="button"
					onClick={onClose}
					className="rounded p-0.5 text-text-secondary hover:bg-black/10 dark:hover:bg-white/10"
					aria-label="スクラッチパッドを閉じる"
				>
					<X size={14} />
				</button>
			</div>

			{/* Editor */}
			<div className="min-h-0 flex-1">
				<CodeMirror
					ref={editorRef}
					className="h-full"
					value={content}
					onChange={handleChange}
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
