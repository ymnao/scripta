// markdownToHtml が出力する katex HTML 用の CSS。SlidePreview は React.lazy 化済みの
// ため初期チャンクには入らず、live-preview math 側の動的 import と Vite が dedupe する（#301）。
import "katex/dist/katex.min.css";
import { memo, useDeferredValue } from "react";
import { useFitScale } from "../../hooks/useFitScale";
import { SLIDE_LOGICAL_HEIGHT, SLIDE_LOGICAL_WIDTH } from "../../types/slide";
import { SlideFrame, useSlideHtml } from "./SlideStage";

export interface SlidePreviewProps {
	markdown: string;
	slideIndex: number;
	totalSlides: number;
}

/**
 * スライドの Markdown プレビューを 16:9 論理サイズで表示する。
 * 表示ペインの寸法に応じて `transform: scale()` で縮小 fit する。
 * 区切り行 `---` はプレビューから除外する。
 */
export const SlidePreview = memo(function SlidePreview({
	markdown,
	slideIndex,
	totalSlides,
}: SlidePreviewProps) {
	const deferredMarkdown = useDeferredValue(markdown);
	const html = useSlideHtml(deferredMarkdown);
	const { ref: boxRef, scale } = useFitScale<HTMLDivElement>(
		SLIDE_LOGICAL_WIDTH,
		SLIDE_LOGICAL_HEIGHT,
	);

	return (
		// 外側 flex-col は「frame + カウンター」をひとまとまりで pane 中央に配置する。
		// カウンターを boxRef の内側に置くことで、frame 直下に gap-3 で貼りつき、
		// pane が縦に長い時でも frame から離れて宙に浮かない (旧 max-w-2xl + gap-3 と同等の視覚)。
		<div className="flex h-full flex-col items-center p-4">
			<div
				ref={boxRef}
				className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3"
				style={{ maxWidth: SLIDE_LOGICAL_WIDTH }}
			>
				<SlideFrame
					scale={scale}
					html={html}
					frameClassName="rounded-lg border border-border bg-white shadow-sm dark:bg-[#2a2a2a]"
				/>
				<span className="text-xs text-text-secondary">
					{slideIndex + 1} / {totalSlides}
				</span>
			</div>
		</div>
	);
});
