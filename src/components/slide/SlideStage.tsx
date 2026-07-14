import { useMemo } from "react";
import { useAsyncDerived } from "../../hooks/useAsyncDerived";
import { renderSlideHtml, renderSlideHtmlWithMermaid } from "../../lib/slide-render";
import { useThemeStore } from "../../stores/theme";
import { useWorkspaceStore } from "../../stores/workspace";
import {
	SLIDE_LOGICAL_HEIGHT,
	SLIDE_LOGICAL_PADDING_PX,
	SLIDE_LOGICAL_WIDTH,
} from "../../types/slide";

/**
 * activeTabPath / theme を Zustand から読みつつスライド HTML を計算するフック。
 *
 * 表示方針: まず sync 版 (mermaid 未変換) を即返し、mermaid preprocess が完了したら
 * 上書きする。入力 (markdown / activeTabPath / theme) が async 完了前に変わった場合は
 * 古い結果を破棄して sync 版に戻す (`useAsyncDerived` の stale ガードで担保)。
 */
export function useSlideHtml(markdown: string): string {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const theme = useThemeStore((s) => s.theme);
	const initial = useMemo(
		() => renderSlideHtml(markdown, activeTabPath),
		[markdown, activeTabPath],
	);
	return useAsyncDerived([markdown, activeTabPath, theme], initial, () =>
		renderSlideHtmlWithMermaid(markdown, activeTabPath, theme),
	);
}

/**
 * 複数スライドの HTML を並列に mermaid 込みでレンダリングするフック。
 * 発表モード (SlideShowOverlay) が全スライドを事前レンダーするのに使う。
 * mount 中 `slides` は snapshot なので通常は 1 回だけ async 実行される。
 *
 * ⚠️ 呼び出し側は `slides` の identity を安定させる (useMemo 等で memoize する)
 * こと。`useAsyncDerived` は `slides` を useEffect 依存として `===` 比較する
 * ため、毎 render で新しい配列を渡すと effect が render 毎に fire し、setState
 * が繰り返し呼ばれて再 render → effect fire → ... のループになる。
 */
export function useSlideHtmls(slides: readonly { content: string }[]): string[] {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const theme = useThemeStore((s) => s.theme);
	const initial = useMemo(
		() => slides.map((s) => renderSlideHtml(s.content, activeTabPath)),
		[slides, activeTabPath],
	);
	return useAsyncDerived([slides, activeTabPath, theme], initial, () =>
		Promise.all(slides.map((s) => renderSlideHtmlWithMermaid(s.content, activeTabPath, theme))),
	);
}

export interface SlideFrameProps {
	scale: number;
	html: string;
	/** 枠 (pixel 寸法 div) に付ける追加クラス。背景・borders・shadow など。 */
	frameClassName?: string;
}

/**
 * 1280×720 論理サイズのスライドを `scale` に合わせて縮小描画する枠 + ステージ。
 * SlidePreview と SlideShowOverlay の両方が使う。
 * `.slide-preview-content` の typography (index.css) を共有する。
 *
 * 呼び出し側は useFitScale の ref を貼った fit container の中に置く
 * (fit container の flex 構成が consumer ごとに違うため SlideFrame は持たない)。
 */
export function SlideFrame({ scale, html, frameClassName }: SlideFrameProps) {
	const stageWidth = SLIDE_LOGICAL_WIDTH * scale;
	const stageHeight = SLIDE_LOGICAL_HEIGHT * scale;
	return (
		<div
			className={`slide-preview-frame relative overflow-hidden ${frameClassName ?? ""}`}
			style={{ width: stageWidth, height: stageHeight }}
		>
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
