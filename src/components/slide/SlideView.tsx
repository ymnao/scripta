import type { EditorView } from "@codemirror/view";
import { ChevronDown, ChevronUp } from "lucide-react";
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
import {
	extractSlideFrontmatterTheme,
	findSlideAtCursor,
	parseSlides,
} from "../../lib/slide-parser";
import { useSettingsStore } from "../../stores/settings";
import {
	SLIDE_PREVIEW_WIDTH_RATIO_MAX,
	SLIDE_PREVIEW_WIDTH_RATIO_MIN,
	SLIDE_PREVIEW_WIDTH_RATIO_STEP,
} from "../../types/slide";
import type { CursorInfo, GoToLineRequest } from "../editor/MarkdownEditor";
import { MarkdownEditor } from "../editor/MarkdownEditor";
import type { SlidePreviewProps } from "./SlidePreview";
import { SlideThumbnails } from "./SlideThumbnails";

// aria-valuenow/min/max は「%」整数を期待するため事前に計算しておく。
const RATIO_ARIA_VALUEMIN = Math.round(SLIDE_PREVIEW_WIDTH_RATIO_MIN * 100);
const RATIO_ARIA_VALUEMAX = Math.round(SLIDE_PREVIEW_WIDTH_RATIO_MAX * 100);

function clampRatio(ratio: number): number {
	return Math.min(SLIDE_PREVIEW_WIDTH_RATIO_MAX, Math.max(SLIDE_PREVIEW_WIDTH_RATIO_MIN, ratio));
}

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

	// Fable #13: プレビュー幅リサイズ。store 値を SoT にしつつドラッグ中は毎フレーム
	// 更新するとディスク I/O が跳ねるため、ドラッグ中は local state に反映して pointerup
	// で store へコミットする。draftRatio は render 用 state、draftRatioRef は
	// pointerup / pointercancel が pure に読み出すための最新値を保持する。
	// 用途を分けることで setState updater 内で副作用 (setPersistedRatio) を呼ぶ
	// React anti-pattern を避けている。
	const persistedRatio = useSettingsStore((s) => s.slidePreviewWidthRatio);
	const setPersistedRatio = useSettingsStore((s) => s.setSlidePreviewWidthRatio);
	const thumbnailsVisible = useSettingsStore((s) => s.slideThumbnailsVisible);
	const setThumbnailsVisible = useSettingsStore((s) => s.setSlideThumbnailsVisible);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [draftRatio, setDraftRatio] = useState<number | null>(null);
	const draftRatioRef = useRef<number | null>(null);
	const activeRatio = clampRatio(draftRatio ?? persistedRatio);

	useEffect(() => {
		setDocText(value);
	}, [value]);

	const slides = useMemo(() => parseSlides(docText), [docText]);

	// Fable #12: frontmatter の `theme:` があれば SlidePreview の app theme を上書きする。
	// deck 全体に効かせる 1 デッキ = 1 テーマの契約。
	const frontmatterTheme = useMemo(() => extractSlideFrontmatterTheme(docText), [docText]);

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

	const handlePointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			const container = containerRef.current;
			if (!container) return;
			// コンテナ矩形はドラッグ中不変（レイアウトが動く経路がない）なので pointerdown で
			// 1 回だけ読み、pointermove 60-120Hz の layout read を避ける。
			const rect = container.getBoundingClientRect();
			if (rect.width <= 0) return;
			e.preventDefault();
			const target = e.currentTarget;
			target.setPointerCapture(e.pointerId);

			// pointermove の React 再 render を 60Hz に throttle する。setDraftRatio 自体で
			// SlideView 全体が再 render され、隣接する MarkdownEditor (memo 化なし) の
			// subtree reconciliation まで走るため、rAF 単位で coalesce する。
			let rafId: number | null = null;
			const onMove = (moveEvent: PointerEvent) => {
				const nextRatio = clampRatio((rect.right - moveEvent.clientX) / rect.width);
				draftRatioRef.current = nextRatio;
				if (rafId !== null) return;
				rafId = requestAnimationFrame(() => {
					rafId = null;
					setDraftRatio(draftRatioRef.current);
				});
			};
			const cleanup = (endEvent: PointerEvent) => {
				target.removeEventListener("pointermove", onMove);
				target.removeEventListener("pointerup", onUp);
				target.removeEventListener("pointercancel", onCancel);
				if (rafId !== null) {
					cancelAnimationFrame(rafId);
					rafId = null;
				}
				if (target.hasPointerCapture(endEvent.pointerId)) {
					target.releasePointerCapture(endEvent.pointerId);
				}
			};
			const onUp = (upEvent: PointerEvent) => {
				cleanup(upEvent);
				const finalRatio = draftRatioRef.current;
				draftRatioRef.current = null;
				setDraftRatio(null);
				if (finalRatio !== null) {
					setPersistedRatio(finalRatio);
				}
			};
			// OS / ブラウザが gesture を中断した場合 (touch → scroll escalation, window
			// blur, system modal 等) はユーザーの意図的な release ではないため、
			// draft を破棄して store には書かない。ARIA/UX 慣例に従う挙動。
			const onCancel = (cancelEvent: PointerEvent) => {
				cleanup(cancelEvent);
				draftRatioRef.current = null;
				setDraftRatio(null);
			};
			target.addEventListener("pointermove", onMove);
			target.addEventListener("pointerup", onUp);
			target.addEventListener("pointercancel", onCancel);
		},
		[setPersistedRatio],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			// WAI-ARIA APG (role="separator"): ArrowLeft = separator を左へ動かす =
			// 左ペイン (editor) が縮む = 右ペイン (preview) が広がる = ratio 増加。
			// ドラッグ方向 (rect.right - clientX) とも符号が一致する。
			// Home/End は「primary pane (editor) を min/max にする」定義なので
			// Home = editor min = preview max ratio、End = editor max = preview min ratio。
			const next =
				e.key === "ArrowLeft"
					? persistedRatio + SLIDE_PREVIEW_WIDTH_RATIO_STEP
					: e.key === "ArrowRight"
						? persistedRatio - SLIDE_PREVIEW_WIDTH_RATIO_STEP
						: e.key === "Home"
							? SLIDE_PREVIEW_WIDTH_RATIO_MAX
							: e.key === "End"
								? SLIDE_PREVIEW_WIDTH_RATIO_MIN
								: null;
			if (next === null) return;
			e.preventDefault();
			setPersistedRatio(clampRatio(next));
		},
		[persistedRatio, setPersistedRatio],
	);

	const previewWidthPct = `${activeRatio * 100}%`;

	// currentSlideIndex は cursorPos → onStatistics 経路の追随に任せ、ここでは
	// editor カーソル移動と focus 引き取りだけを行う。
	const handleSelectSlide = useCallback(
		(index: number) => {
			const view = editorViewRef.current;
			const slide = slides[index];
			if (!view || !slide) return;
			view.dispatch({
				selection: { anchor: slide.from },
				scrollIntoView: true,
			});
			view.focus();
		},
		[slides],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={containerRef} className="flex min-h-0 flex-1">
				<div className="min-h-0 min-w-0 flex-1">
					<MarkdownEditor
						value={value}
						onDocChanged={handleDocChanged}
						onSave={onSave}
						onEditorView={handleEditorView}
						goToLine={goToLine}
						onGoToLineDone={onGoToLineDone}
						onStatistics={handleStatistics}
						slideSeparatorMode
					/>
				</div>
				{/* biome-ignore lint/a11y/useSemanticElements: separator role is the ARIA
				    convention for a resize handle; <hr> would collapse the split panes. */}
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="スライドプレビューの幅を調整"
					aria-valuemin={RATIO_ARIA_VALUEMIN}
					aria-valuemax={RATIO_ARIA_VALUEMAX}
					aria-valuenow={Math.round(activeRatio * 100)}
					tabIndex={0}
					onPointerDown={handlePointerDown}
					onKeyDown={handleKeyDown}
					data-testid="slide-preview-resize-handle"
					className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-text-link focus:bg-text-link focus:outline-none"
				/>
				<div
					className="min-h-0 bg-bg-secondary"
					style={{ width: previewWidthPct }}
					data-testid="slide-preview-pane"
				>
					<Suspense fallback={null}>
						<SlidePreview
							markdown={currentSlide?.content ?? ""}
							slideIndex={currentSlideIndex}
							totalSlides={slides.length}
							themeOverride={frontmatterTheme}
						/>
					</Suspense>
				</div>
			</div>
			{/* 1 枚だけなら SlideThumbnails を mount しない。内部 gate だと
			    useSlideHtmls (hook) が early return 前に unconditional で発火し、
			    単一 slide deck でも Promise.all(mermaid preprocess) を毎キー走らせて
			    しまうため、gate は呼び出し側で mount を抑える。
			    thumbnailsVisible が false の時も同様に mount しない (再表示時に
			    再描画する trade-off で hidden 時の CPU / メモリを節約)。 */}
			{slides.length > 1 && (
				<div className="flex shrink-0 flex-col">
					<button
						type="button"
						onClick={() => setThumbnailsVisible(!thumbnailsVisible)}
						aria-pressed={thumbnailsVisible}
						aria-label={thumbnailsVisible ? "サムネイル一覧を非表示" : "サムネイル一覧を表示"}
						data-testid="slide-thumbnails-toggle"
						className="flex h-5 items-center justify-center border-t border-border bg-bg-secondary text-text-secondary hover:bg-black/5 dark:hover:bg-white/5"
					>
						{/* 展開時 = 上向き (click で閉じる = content が上に畳まれる方向)、
						    折り畳み時 = 下向き (click で開く = 下から現れる方向)。 */}
						{thumbnailsVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</button>
					{thumbnailsVisible && (
						<SlideThumbnails
							slides={slides}
							currentSlideIndex={currentSlideIndex}
							themeOverride={frontmatterTheme}
							onSelectSlide={handleSelectSlide}
						/>
					)}
				</div>
			)}
		</div>
	);
}
