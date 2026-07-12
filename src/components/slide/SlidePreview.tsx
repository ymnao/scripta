// markdownToHtml が出力する katex HTML 用の CSS。SlidePreview は React.lazy 化済みの
// ため初期チャンクには入らず、live-preview math 側の動的 import と Vite が dedupe する（#301）。
import "katex/dist/katex.min.css";
import { memo, useDeferredValue, useMemo } from "react";
import { markdownToHtml } from "../../lib/markdown-to-html";
import { resolveHtmlImageSrcs } from "../../lib/resolve-html-images";
import { useWorkspaceStore } from "../../stores/workspace";

export interface SlidePreviewProps {
	markdown: string;
	slideIndex: number;
	totalSlides: number;
}

/**
 * スライドの Markdown プレビューを 16:9 アスペクト比で表示する。
 * 区切り行 `---` はプレビューから除外する。
 */
export const SlidePreview = memo(function SlidePreview({
	markdown,
	slideIndex,
	totalSlides,
}: SlidePreviewProps) {
	const deferredMarkdown = useDeferredValue(markdown);
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);

	const html = useMemo(() => {
		// 末尾の区切り行を除去してプレビュー
		const cleaned = deferredMarkdown.replace(/\n---\s*$/, "").trim();
		if (!cleaned) return "";
		return resolveHtmlImageSrcs(markdownToHtml(cleaned), activeTabPath);
	}, [deferredMarkdown, activeTabPath]);

	return (
		<div className="flex h-full flex-col items-center justify-center p-4">
			<div className="flex w-full max-w-2xl flex-col items-center gap-3">
				<div className="slide-preview-frame w-full">
					<div className="slide-preview aspect-video overflow-y-auto rounded-lg border border-border bg-white p-8 dark:bg-[#2a2a2a]">
						{html ? (
							<div
								className="slide-preview-content"
								// biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify 済み
								dangerouslySetInnerHTML={{ __html: html }}
							/>
						) : (
							<div className="flex h-full items-center justify-center text-sm text-text-secondary">
								空のスライド
							</div>
						)}
					</div>
				</div>
				<span className="text-xs text-text-secondary">
					{slideIndex + 1} / {totalSlides}
				</span>
			</div>
		</div>
	);
});
