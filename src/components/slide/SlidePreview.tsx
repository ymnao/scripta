// markdownToHtml が出力する katex HTML 用の CSS。SlidePreview は React.lazy 化済みの
// ため初期チャンクには入らず、live-preview math 側の動的 import と Vite が dedupe する（#301）。
import "katex/dist/katex.min.css";
import { memo, useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from "react";
import { markdownToHtml } from "../../lib/markdown-to-html";
import { resolveHtmlImageSrcs } from "../../lib/resolve-html-images";
import { useWorkspaceStore } from "../../stores/workspace";
import {
	SLIDE_LOGICAL_HEIGHT,
	SLIDE_LOGICAL_PADDING_PX,
	SLIDE_LOGICAL_WIDTH,
} from "../../types/slide";

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
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);

	const html = useMemo(() => {
		// 末尾の区切り行を除去してプレビュー
		const cleaned = deferredMarkdown.replace(/\n---\s*$/, "").trim();
		if (!cleaned) return "";
		return resolveHtmlImageSrcs(markdownToHtml(cleaned), activeTabPath);
	}, [deferredMarkdown, activeTabPath]);

	const boxRef = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);

	// useLayoutEffect + 同期 update() で初回描画から正しい stage 寸法にする（scale=1 の
	// 初期値で 1 フレーム描いてから setState でジャンプする flash を回避）。
	// ResizeObserver からの通知は rAF で 1 フレーム分に coalesce し、splitter drag 中の
	// 連続再レンダーを 60fps に抑える。
	useLayoutEffect(() => {
		const el = boxRef.current;
		if (!el) return;
		const update = () => {
			const w = el.clientWidth;
			const h = el.clientHeight;
			if (w <= 0 || h <= 0) return;
			setScale(Math.min(w / SLIDE_LOGICAL_WIDTH, h / SLIDE_LOGICAL_HEIGHT));
		};
		update();
		// jsdom には ResizeObserver がないため、テストでは test-setup 側で no-op mock を注入する。
		if (typeof ResizeObserver === "undefined") return;
		let rafId: number | null = null;
		const ro = new ResizeObserver(() => {
			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				update();
			});
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, []);

	const stageWidth = SLIDE_LOGICAL_WIDTH * scale;
	const stageHeight = SLIDE_LOGICAL_HEIGHT * scale;

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
				<div
					className="slide-preview-frame relative overflow-hidden rounded-lg border border-border bg-white shadow-sm dark:bg-[#2a2a2a]"
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
				<span className="text-xs text-text-secondary">
					{slideIndex + 1} / {totalSlides}
				</span>
			</div>
		</div>
	);
});
