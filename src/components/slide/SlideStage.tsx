import { useMemo } from "react";
import { useAsyncDerived } from "../../hooks/useAsyncDerived";
import { renderSlideHtml, renderSlideHtmlWithMermaid } from "../../lib/slide-render";
import { useThemeStore } from "../../stores/theme";
import { useWorkspaceStore } from "../../stores/workspace";
import {
	SLIDE_LOGICAL_HEIGHT,
	SLIDE_LOGICAL_PADDING_PX,
	SLIDE_LOGICAL_WIDTH,
	type SlideTheme,
} from "../../types/slide";

/** frontmatter override があれば優先、無ければ app theme (Fable #12)。 */
function useResolvedSlideTheme(themeOverride: SlideTheme | null | undefined): SlideTheme {
	const appTheme = useThemeStore((s) => s.theme);
	return themeOverride ?? appTheme;
}

/**
 * activeTabPath / theme を Zustand から読みつつスライド HTML を計算するフック。
 *
 * 表示方針: まず sync 版 (mermaid 未変換) を即返し、mermaid preprocess が完了したら
 * 上書きする。入力が async 完了前に変わった場合は `useAsyncDerived` の keepPrevious
 * で前回成功値を保持しつつ次で上書き。`themeOverride` は Fable #12 の frontmatter theme。
 *
 * per-content の重複 render 抑止 / 別 hook instance (SlideThumbnails 等) とのキャッシュ共有は
 * `slide-render.ts` の module-level cache に委譲する。
 */
export function useSlideHtml(markdown: string, themeOverride?: SlideTheme | null): string {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const theme = useResolvedSlideTheme(themeOverride);
	const initial = useMemo(
		() => renderSlideHtml(markdown, activeTabPath),
		[markdown, activeTabPath],
	);
	return useAsyncDerived([markdown, activeTabPath, theme], initial, (signal) =>
		renderSlideHtmlWithMermaid(markdown, activeTabPath, theme, { signal }),
	);
}

/**
 * 複数スライドの HTML を並列に mermaid 込みでレンダリングするフック。
 * 発表モード (SlideShowOverlay) / サムネイル一覧 / 大デッキ preview の 3 消費者が使う。
 *
 * ⚠️ 呼び出し側は `slides` の identity を安定させる (useMemo 等で memoize する)
 * こと。`useAsyncDerived` は `slides` を useEffect 依存として `===` 比較する
 * ため、毎 render で新しい配列を渡すと effect が render 毎に fire し、setState
 * が繰り返し呼ばれて再 render → effect fire → ... のループになる。
 *
 * per-content の dedup / 別 hook instance との共有 / LRU eviction はすべて
 * `slide-render.ts` の module-level cache に委譲する。以前は hook-instance-local な
 * `useRef` cache + per-entry AbortController を持っていたが、SlidePreview の
 * useSlideHtml と SlideThumbnails の useSlideHtmls が同一スライドを重複 render する
 * altitude 課題を解消するため module scope に集約した (session 91)。caller の signal は
 * `renderSlideHtmlWithMermaid` 内で「新規 render を起動しない」pre-check にのみ使われる。
 */
export function useSlideHtmls(
	slides: readonly { content: string }[],
	themeOverride?: SlideTheme | null,
): string[] {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const theme = useResolvedSlideTheme(themeOverride);
	const initial = useMemo(
		() => slides.map((s) => renderSlideHtml(s.content, activeTabPath)),
		[slides, activeTabPath],
	);
	return useAsyncDerived([slides, activeTabPath, theme], initial, (signal) =>
		Promise.all(
			slides.map((s) => renderSlideHtmlWithMermaid(s.content, activeTabPath, theme, { signal })),
		),
	);
}

export interface SlideFrameProps {
	scale: number;
	html: string;
	/** 枠 (pixel 寸法 div) に付ける追加クラス。borders・shadow など。 */
	frameClassName?: string;
	/** Fable #12: `.slide-theme-*` を付与して deck-level テーマを固定する。 */
	themeOverride?: SlideTheme | null;
}

/**
 * 1280×720 論理サイズのスライドを `scale` に合わせて縮小描画する枠 + ステージ。
 * SlidePreview と SlideShowOverlay の両方が使う。
 * `.slide-preview-content` の typography (index.css) を共有する。
 *
 * 呼び出し側は useFitScale の ref を貼った fit container の中に置く
 * (fit container の flex 構成が consumer ごとに違うため SlideFrame は持たない)。
 */
export function SlideFrame({ scale, html, frameClassName, themeOverride }: SlideFrameProps) {
	const stageWidth = SLIDE_LOGICAL_WIDTH * scale;
	const stageHeight = SLIDE_LOGICAL_HEIGHT * scale;
	const classes = [
		"slide-preview-frame relative overflow-hidden",
		frameClassName,
		themeOverride && `slide-theme-${themeOverride}`,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className={classes} style={{ width: stageWidth, height: stageHeight }}>
			<div
				className="slide-preview absolute left-0 top-0 origin-top-left"
				style={{
					width: SLIDE_LOGICAL_WIDTH,
					height: SLIDE_LOGICAL_HEIGHT,
					padding: SLIDE_LOGICAL_PADDING_PX,
					transform: `scale(${scale})`,
				}}
			>
				{html ? (
					<div
						className="slide-preview-content"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: finalizeHtml 済み (sanitize-after pattern)
						dangerouslySetInnerHTML={{ __html: html }}
					/>
				) : (
					<div className="flex h-full items-center justify-center text-2xl text-text-secondary">
						空のスライド
					</div>
				)}
			</div>
		</div>
	);
}
