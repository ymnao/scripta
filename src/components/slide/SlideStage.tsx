import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAsyncDerived } from "../../hooks/useAsyncDerived";
import { isAbortError } from "../../lib/abort";
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
 * 昇順の `pending` (空でない) から、`priority` 以上で最初のもの、無ければ先頭を返す。
 * `priority` から後ろへ進み末尾で先頭に戻る順になるので、発表中は次に送るスライドが先に描かれる。
 */
function pickNextSlide(pending: readonly number[], priority: number): number {
	return pending.find((i) => i >= priority) ?? pending[0];
}

/**
 * 複数スライドの HTML を mermaid 込みでレンダリングするフック。
 * 発表モード (SlideShowOverlay) とサムネイル一覧 (SlideThumbnails) が使う。
 *
 * スライドは 1 枚ずつ描き、描き終えたスライドからその場で反映する。次に描くのは
 * `priorityIndex` (表示中・選択中のスライド) に近い未描画のスライドで、描画の途中で
 * `priorityIndex` が変われば次の 1 枚から新しい位置を優先する (#663)。
 * 全スライドを同時に起動しないのは、mermaid の描画が `renderQueue` で直列なうえ、
 * `preprocessMermaidBlocks` が 1 枚の中の図を 1 つずつ await するため。同時に起動すると
 * 表示中のスライドの 2 つ目以降の図が、他の全スライドの 1 つ目の図の後ろに並ぶ。
 * 図のないスライドは同期版と同じ HTML になるので、待たされても見た目は変わらない。
 *
 * まだ描いていないスライドは、同じ位置の直前の描画結果 (theme 切替や編集の前の値) を
 * 返し、それも無ければ同期版 (mermaid は fenced code のまま) を返す。
 *
 * ⚠️ 呼び出し側は `slides` の identity を安定させる (useMemo 等で memoize する)
 * こと。`slides` は useEffect 依存として `===` 比較されるため、毎 render で新しい
 * 配列を渡すと描画が render 毎にやり直しになる。
 *
 * per-content の dedup / 別 hook instance との共有 / LRU eviction はすべて
 * `slide-render.ts` の module-level cache に委譲する (session 91)。caller の signal は
 * `renderSlideHtmlWithMermaid` 内で「新規 render を起動しない」pre-check にのみ使われる。
 */
export function useSlideHtmls(
	slides: readonly { content: string }[],
	themeOverride?: SlideTheme | null,
	priorityIndex = 0,
): string[] {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const theme = useResolvedSlideTheme(themeOverride);
	const initial = useMemo(
		() => slides.map((s) => renderSlideHtml(s.content, activeTabPath)),
		[slides, activeTabPath],
	);
	const [rendered, setRendered] = useState<readonly (string | undefined)[]>([]);
	const priorityRef = useRef(priorityIndex);
	useLayoutEffect(() => {
		priorityRef.current = priorityIndex;
	}, [priorityIndex]);

	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		const pending = [...slides.keys()];
		void (async () => {
			while (pending.length > 0) {
				const i = pickNextSlide(pending, priorityRef.current);
				pending.splice(pending.indexOf(i), 1);
				let html: string;
				try {
					html = await renderSlideHtmlWithMermaid(slides[i].content, activeTabPath, theme, {
						signal,
					});
				} catch (err) {
					if (signal.aborted) return;
					// AbortError は共有 promise が clearSlideRenderCache で中断されたケース。
					// 設計上のキャンセルなので log せず、他のスライドは続けて描く。
					if (!isAbortError(err)) console.error("[useSlideHtmls] slide render failed:", err);
					continue;
				}
				if (signal.aborted) return;
				setRendered((prev) => {
					if (prev[i] === html) return prev;
					const next = prev.slice();
					next[i] = html;
					return next;
				});
			}
		})();
		return () => controller.abort();
	}, [slides, activeTabPath, theme]);

	return useMemo(() => initial.map((html, i) => rendered[i] ?? html), [initial, rendered]);
}

/** `.slide-preview` の上端から、下の padding が始まるまでの距離。 */
const SLIDE_CONTENT_BOTTOM = SLIDE_LOGICAL_HEIGHT - SLIDE_LOGICAL_PADDING_PX;

/**
 * `.slide-preview-content` が padding の内側に収まっていないかを返す。
 * offset* / scroll* / clientWidth は transform 前の論理 px なので、表示倍率に依らない。
 * 高さに offsetHeight を使わないのは、raw HTML の float の子 (`<img align="left">` 等) が
 * 要素の高さを伸ばさずに下へ突き抜けるため。scrollHeight はその分を含み、それ以外では
 * offsetHeight と同じ値になる。
 * 高さだけで比べないのは、先頭の子の margin-top (`.katex-display` の 1em 等) が
 * margin collapse で本文要素の外に出て、要素ごと下へ押し下げるため。offsetParent は
 * absolute の `.slide-preview` なので、offsetTop がその分を含む。
 * 最後の子の margin-bottom は同じ collapse で高さに入らない。
 * `pre` は自身が横スクロールするので、中の長い行は scrollWidth に出ない (対象外)。
 */
export function isSlideContentOverflowing(content: HTMLElement): boolean {
	return (
		content.offsetTop + content.scrollHeight > SLIDE_CONTENT_BOTTOM ||
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
