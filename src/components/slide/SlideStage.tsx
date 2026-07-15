import { useMemo, useRef } from "react";
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
 */
export function useSlideHtml(markdown: string, themeOverride?: SlideTheme | null): string {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const theme = useResolvedSlideTheme(themeOverride);
	const initial = useMemo(
		() => renderSlideHtml(markdown, activeTabPath),
		[markdown, activeTabPath],
	);
	return useAsyncDerived([markdown, activeTabPath, theme], initial, () =>
		renderSlideHtmlWithMermaid(markdown, activeTabPath, theme),
	);
}

interface PerSlideCache<T> {
	key: string;
	map: Map<string, T>;
}

/**
 * `slides` の content 文字列をキーに前回結果を再利用する per-slide キャッシュ。
 * `cacheKey` 変化で全消し (activeTabPath / theme 等 render 結果に効く外部依存)、
 * 現在の slides に無い content は末尾で prune して無制限成長を防ぐ。
 * sync (T=string) / async (T=Promise<string>) 双方で同じ骨格を使い、
 * 後者は in-flight promise 共有で重複 content の並列 render も 1 回に畳む。
 */
function mapPerSlideCached<T>(
	cacheRef: { current: PerSlideCache<T> },
	cacheKey: string,
	slides: readonly { content: string }[],
	compute: (content: string) => T,
): T[] {
	const cache = cacheRef.current;
	if (cache.key !== cacheKey) {
		cache.key = cacheKey;
		cache.map = new Map();
	}
	const currentContents = new Set<string>();
	const result = slides.map((s) => {
		currentContents.add(s.content);
		const cached = cache.map.get(s.content);
		if (cached !== undefined) return cached;
		const value = compute(s.content);
		cache.map.set(s.content, value);
		return value;
	});
	for (const key of cache.map.keys()) {
		if (!currentContents.has(key)) cache.map.delete(key);
	}
	return result;
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
 * per-slide キャッシュ: content 文字列をキーに前回描画結果を保持し、typing で
 * 1 枚だけ変わる大デッキで N-1 枚分の markdownToHtml + DOMPurify + mermaid
 * preprocess を丸ごとスキップする。activeTabPath / theme が変わったら cache
 * は成果物 identity が変わるため全クリアする。
 */
export function useSlideHtmls(
	slides: readonly { content: string }[],
	themeOverride?: SlideTheme | null,
): string[] {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const theme = useResolvedSlideTheme(themeOverride);
	const syncCacheRef = useRef<PerSlideCache<string>>({
		key: "",
		map: new Map(),
	});
	const asyncCacheRef = useRef<PerSlideCache<Promise<string>>>({
		key: "",
		map: new Map(),
	});
	const initial = useMemo(
		() =>
			mapPerSlideCached(syncCacheRef, activeTabPath ?? "", slides, (content) =>
				renderSlideHtml(content, activeTabPath),
			),
		[slides, activeTabPath],
	);
	return useAsyncDerived([slides, activeTabPath, theme], initial, () =>
		Promise.all(
			mapPerSlideCached(asyncCacheRef, `${activeTabPath ?? ""}\0${theme}`, slides, (content) => {
				const p = renderSlideHtmlWithMermaid(content, activeTabPath, theme);
				// 失敗した Promise を cache に固定させない (次 render で retry させる)。
				p.catch(() => {
					const cache = asyncCacheRef.current;
					if (cache.map.get(content) === p) cache.map.delete(content);
				});
				return p;
			}),
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
						// biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify 済み
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
