import type { EditorView } from "@codemirror/view";
import {
	type ComponentType,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
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
	// value prop は #302 以降 loadedDoc（ロード / タブ切替 / 外部リロード時のみ更新）で、
	// キー入力では変わらない。プレビュー用の doc は editorView から onDocChanged 経由で
	// 都度読み直して内部 state に反映する。value 変化時は差し替えとして同期する。
	const [docText, setDocText] = useState(value);
	const editorViewRef = useRef<EditorView | null>(null);

	useEffect(() => {
		setDocText(value);
	}, [value]);

	const slides = useMemo(() => parseSlides(docText), [docText]);

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

	// docChanged 発火時（selectionSet では発火しない）に doc を読み直す。
	// onStatistics は rAF スケジューリング (MarkdownEditor.tsx:415) で 1 フレーム
	// 遅れて cursorPos を更新するため、doc と cursor を同じ tick で反映しないと
	// 「区切り挿入直後に slides は増えたのに cursor が古い → 1 フレームだけ前の
	// スライドが表示される」flicker が起きる。handleDocChanged 内で cursorPos も
	// 同時に読み直しておくことで desync を防ぐ。
	const handleDocChanged = useCallback(() => {
		const view = editorViewRef.current;
		if (view) {
			setDocText(view.state.doc.toString());
			setCursorPos(view.state.selection.main.head);
		}
		onDocChanged?.();
	}, [onDocChanged]);

	// selectionSet のみで発火する経路（純カーソル移動）のためのバックアップ。
	// doc 変更時は handleDocChanged 側で cursorPos を先に更新する。
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
					onDocChanged={handleDocChanged}
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
