import type { EditorView } from "@codemirror/view";
import { type ComponentType, lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { findSlideAtCursor, parseSlides } from "../../lib/slide-parser";
import type { CursorInfo, GoToLineRequest } from "../editor/MarkdownEditor";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import type { SlidePreviewProps } from "./SlidePreview";

/** chunk ロード失敗時のフォールバック。このリポジトリは ErrorBoundary を持たない
 *  （クラスコンポーネント禁止）ため import 側で catch し、プレビューペインのみ
 *  degrade させてアプリ全体の白画面化を防ぐ。 */
function SlidePreviewLoadError(_props: SlidePreviewProps) {
	return (
		<div className="flex h-full items-center justify-center text-sm text-text-secondary">
			スライドプレビューの読み込みに失敗しました。アプリを再起動してください。
		</div>
	);
}

// SlidePreview → markdown-to-html → katex の静的 import チェーンを初期チャンクから
// 切り離すため lazy 化する（#301）。
const SlidePreview = lazy(
	(): Promise<{ default: ComponentType<SlidePreviewProps> }> =>
		import("./SlidePreview").then(
			(m) => ({ default: m.SlidePreview }),
			() => ({ default: SlidePreviewLoadError }),
		),
);

interface SlideViewProps {
	value: string;
	onDocChanged?: () => void;
	onSave: () => void;
	onEditorView?: (view: EditorView | null) => void;
	goToLine?: GoToLineRequest | null;
	onGoToLineDone?: () => void;
	onStatistics?: (info: CursorInfo) => void;
}

export function SlideView({
	value,
	onDocChanged,
	onSave,
	onEditorView,
	goToLine,
	onGoToLineDone,
	onStatistics,
}: SlideViewProps) {
	const [cursorPos, setCursorPos] = useState(0);
	const editorViewRef = useRef<EditorView | null>(null);

	const slides = useMemo(() => parseSlides(value), [value]);

	const currentSlideIndex = useMemo(
		() => findSlideAtCursor(slides, cursorPos),
		[slides, cursorPos],
	);

	const currentSlide = slides[currentSlideIndex];

	const handleEditorView = useCallback(
		(view: EditorView | null) => {
			editorViewRef.current = view;
			onEditorView?.(view);
		},
		[onEditorView],
	);

	// カーソル位置を onStatistics コールバック経由で更新
	// MarkdownEditor が updateListener で onStatistics を呼ぶので、
	// そこでカーソル位置も取得する
	const handleStatistics = useCallback(
		(info: CursorInfo) => {
			const view = editorViewRef.current;
			if (view) {
				setCursorPos(view.state.selection.main.head);
			}
			onStatistics?.(info);
		},
		[onStatistics],
	);

	return (
		<div className="flex min-h-0 flex-1">
			<div className="min-h-0 min-w-0 flex-1">
				<MarkdownEditor
					value={value}
					onDocChanged={onDocChanged}
					onSave={onSave}
					onEditorView={handleEditorView}
					goToLine={goToLine}
					onGoToLineDone={onGoToLineDone}
					onStatistics={handleStatistics}
				/>
			</div>
			<div className="min-h-0 w-[45%] border-l border-border bg-bg-secondary">
				<Suspense fallback={null}>
					<SlidePreview
						markdown={currentSlide?.content ?? ""}
						slideIndex={currentSlideIndex}
						totalSlides={slides.length}
					/>
				</Suspense>
			</div>
		</div>
	);
}
