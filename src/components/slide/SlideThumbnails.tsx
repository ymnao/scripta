// SlideView → SlideThumbnails は eager import chain のため、SlidePreview / Overlay の
// lazy chunk に閉じている katex CSS を eager path でも確保する必要がある。
// Vite の INEFFECTIVE_DYNAMIC_IMPORT warning は他 2 箇所と同じ既知の噪音。
import "katex/dist/katex.min.css";
import { memo, useEffect, useRef } from "react";
import {
	SLIDE_LOGICAL_WIDTH,
	SLIDE_THUMBNAIL_WIDTH,
	type SlideSection,
	type SlideTheme,
} from "../../types/slide";
import { SlideFrame, useSlideHtmls } from "./SlideStage";

const THUMB_SCALE = SLIDE_THUMBNAIL_WIDTH / SLIDE_LOGICAL_WIDTH;

export interface SlideThumbnailsProps {
	slides: SlideSection[];
	currentSlideIndex: number;
	/** Fable #12: frontmatter `theme:` 由来の deck-level テーマ。null なら app theme。 */
	themeOverride?: SlideTheme | null;
	onSelectSlide: (index: number) => void;
}

/**
 * スライドサムネイル一覧。preview ペイン下部に横スクロールで並べ、クリックで
 * editor をそのスライドへ jump する。
 *
 * useSlideHtmls を再利用して mermaid 込みの全スライド HTML を一括レンダーする。
 * 大 deck (>50 slide) は per-slide cache 化 (HANDOFF §80 defer) の合流点で、
 * MVP は一括で許容する。SlideFrame は固定 scale で描画するため useFitScale の
 * ResizeObserver は不要 (thumbnail は常に同一寸法)。
 */
export const SlideThumbnails = memo(function SlideThumbnails({
	slides,
	currentSlideIndex,
	themeOverride,
	onSelectSlide,
}: SlideThumbnailsProps) {
	const htmls = useSlideHtmls(slides, themeOverride);
	const navRef = useRef<HTMLElement>(null);
	const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

	// current thumbnail が水平スクロール範囲外なら nav の scrollLeft を最小移動で調整。
	// scrollIntoView は祖先まで scroll し得るため使わず、nav 内で局所化する。
	useEffect(() => {
		const nav = navRef.current;
		const btn = buttonRefs.current[currentSlideIndex];
		if (!nav || !btn) return;
		const navRect = nav.getBoundingClientRect();
		const btnRect = btn.getBoundingClientRect();
		if (btnRect.left < navRect.left) {
			nav.scrollBy({ left: btnRect.left - navRect.left, behavior: "smooth" });
		} else if (btnRect.right > navRect.right) {
			nav.scrollBy({ left: btnRect.right - navRect.right, behavior: "smooth" });
		}
	}, [currentSlideIndex]);

	return (
		<nav
			ref={navRef}
			className="flex shrink-0 gap-2 overflow-x-auto border-t border-border bg-bg-secondary p-2"
			data-testid="slide-thumbnails"
			aria-label="スライドサムネイル一覧"
		>
			{slides.map((slide, index) => {
				const isCurrent = index === currentSlideIndex;
				return (
					<button
						// slide.from は挿入・削除で既存スライドの安定性が保たれるため
						// index より key として優れる (index だと挿入時に全 thumbnail 再描画)。
						key={slide.from}
						ref={(node) => {
							buttonRefs.current[index] = node;
						}}
						type="button"
						onClick={() => onSelectSlide(index)}
						aria-current={isCurrent ? "true" : undefined}
						aria-label={`スライド ${index + 1} を表示`}
						className={`flex shrink-0 flex-col items-center gap-1 rounded p-1 focus:outline-none focus:ring-2 focus:ring-text-link ${
							isCurrent ? "bg-text-link/10 ring-2 ring-text-link" : "hover:bg-bg-primary"
						}`}
					>
						<SlideFrame
							scale={THUMB_SCALE}
							html={htmls[index] ?? ""}
							themeOverride={themeOverride}
							frameClassName="rounded border border-border bg-white dark:bg-[#2a2a2a]"
						/>
						<span className="text-xs text-text-secondary">{index + 1}</span>
					</button>
				);
			})}
		</nav>
	);
});
