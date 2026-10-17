import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** `.slide-preview` の上端から、下の padding が始まるまでの距離。 */
const SLIDE_CONTENT_BOTTOM = SLIDE_LOGICAL_HEIGHT - SLIDE_LOGICAL_PADDING_PX;

/**
 * `.slide-preview-content` が padding の内側に収まっていないかを返す。
 * offset* / clientWidth は transform 前の論理 px なので、表示倍率に依らない。
 * offsetHeight だけで比べないのは、先頭の子の margin-top (`.katex-display` の 1em 等) が
 * margin collapse で本文要素の外に出て、要素ごと下へ押し下げるため。offsetParent は
 * absolute の `.slide-preview` なので、offsetTop がその分を含む。
 * 最後の子の margin-bottom は同じ collapse で offsetHeight に入らない。
 * `pre` は自身が横スクロールするので、中の長い行は scrollWidth に出ない (対象外)。
 */
export function isSlideContentOverflowing(content: HTMLElement): boolean {
	return (
		content.offsetTop + content.offsetHeight > SLIDE_CONTENT_BOTTOM ||
		content.scrollWidth > content.clientWidth
	);
}

/**
 * `enabled` のときだけ本文要素のはみ出しを測る。html の差し替え (mermaid の描画完了) は
 * effect の依存で、画像やフォントの読み込みによる高さの変化は ResizeObserver で拾う。
 */
function useSlideOverflow(
	enabled: boolean,
	html: string,
): { ref: RefObject<HTMLDivElement | null>; overflowing: boolean } {
	const ref = useRef<HTMLDivElement | null>(null);
	const [overflowing, setOverflowing] = useState(false);

	useLayoutEffect(() => {
		const el = ref.current;
		// 空のスライドは本文要素を描画しないので `!el` だけでも同じ判定になる。`html` を読むのは、
		// html の差し替えで測り直すための依存を biome (useExhaustiveDependencies) に認めさせるため。
		if (!enabled || !html || !el) {
			setOverflowing(false);
			return;
		}
		const update = () => setOverflowing(isSlideContentOverflowing(el));
		update();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, [enabled, html]);

	return { ref, overflowing };
}

/**
 * はみ出したときの印。`bar` は枠の下端の帯だけ、`badge` は帯に加えて文言を出す。
 * 未指定なら測らない (スライドショーは出力と同じ見た目を保つ)。
 */
export type SlideOverflowIndicator = "badge" | "bar";

export const SLIDE_OVERFLOW_MESSAGE = "内容が枠に収まっていません";

export interface SlideFrameProps {
	scale: number;
	html: string;
	/** 枠 (pixel 寸法 div) に付ける追加クラス。borders・shadow など。 */
	frameClassName?: string;
	/** Fable #12: `.slide-theme-*` を付与して deck-level テーマを固定する。 */
	themeOverride?: SlideTheme | null;
	overflowIndicator?: SlideOverflowIndicator;
	/**
	 * 印の読み上げ文言 (sr-only) に付ける id。サムネイルのように枠を `aria-label` 付きの
	 * ボタンで包むと中の文言は名前に入らないので、呼び出し側が `aria-describedby` で参照する。
	 * はみ出していないときは要素ごと無い。
	 */
	overflowIndicatorId?: string;
}

/**
 * 1280×720 論理サイズのスライドを `scale` に合わせて縮小描画する枠 + ステージ。
 * SlidePreview と SlideShowOverlay の両方が使う。
 * `.slide-preview-content` の typography (index.css) を共有する。
 *
 * 呼び出し側は useFitScale の ref を貼った fit container の中に置く
 * (fit container の flex 構成が consumer ごとに違うため SlideFrame は持たない)。
 */
export function SlideFrame({
	scale,
	html,
	frameClassName,
	themeOverride,
	overflowIndicator,
	overflowIndicatorId,
}: SlideFrameProps) {
	const { ref: contentRef, overflowing } = useSlideOverflow(overflowIndicator !== undefined, html);
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
						ref={contentRef}
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
			{overflowing && (
				<div
					className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-red-500"
					data-testid="slide-overflow-bar"
				>
					<span id={overflowIndicatorId} className="sr-only">
						{SLIDE_OVERFLOW_MESSAGE}
					</span>
				</div>
			)}
			{overflowing && overflowIndicator === "badge" && (
				<span
					className="pointer-events-none absolute right-2 bottom-3 rounded bg-red-600 px-2 py-0.5 text-xs text-white"
					aria-hidden="true"
				>
					収まっていません
				</span>
			)}
		</div>
	);
}
