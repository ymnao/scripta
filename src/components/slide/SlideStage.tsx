import { useMemo } from "react";
import { markdownToHtml } from "../../lib/markdown-to-html";
import { resolveHtmlImageSrcs } from "../../lib/resolve-html-images";
import { useWorkspaceStore } from "../../stores/workspace";
import {
	SLIDE_LOGICAL_HEIGHT,
	SLIDE_LOGICAL_PADDING_PX,
	SLIDE_LOGICAL_WIDTH,
} from "../../types/slide";

/**
 * スライド本文の Markdown を DOMPurify 済み HTML に変換する純粋関数。
 * 末尾の区切り行 `---` は除去する (プレビュー / 発表モードの共通仕様)。
 */
export function renderSlideHtml(markdown: string, activeTabPath: string | null): string {
	const cleaned = markdown.replace(/\n---\s*$/, "").trim();
	if (!cleaned) return "";
	return resolveHtmlImageSrcs(markdownToHtml(cleaned), activeTabPath);
}

/**
 * activeTabPath を Zustand から読みつつ renderSlideHtml を memoize するフック。
 * SlidePreview のようにキーストロークごとに再レンダーされる場合に有効。
 */
export function useSlideHtml(markdown: string): string {
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	return useMemo(() => renderSlideHtml(markdown, activeTabPath), [markdown, activeTabPath]);
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
