import "katex/dist/katex.min.css";
import { useEffect, useMemo, useState } from "react";
import { useFitScale } from "../../hooks/useFitScale";
import { useWorkspaceStore } from "../../stores/workspace";
import type { SlideSection } from "../../types/slide";
import { SLIDE_LOGICAL_HEIGHT, SLIDE_LOGICAL_WIDTH } from "../../types/slide";
import { renderSlideHtml, SlideFrame } from "./SlideStage";

export interface SlideShowOverlayProps {
	slides: SlideSection[];
	startIndex: number;
	onClose: () => void;
}

/**
 * 発表モード最小版 (Fable #5)。
 * SlidePreview と `SlideFrame` (論理サイズ 1280×720 / padding / typography) と
 * `useFitScale` を共有し、viewport 全体に fit させる。
 *
 * `slides` は AppLayout 側で 1 回だけ parseSlides した結果を受け取る (F5 押下時に
 * markdown を snapshot する仕様のため mount 中は変化しない)。全スライドの HTML を
 * 事前レンダーしてナビゲーション時のリレンダーを避ける。
 *
 * キーバインド (`capture: true` で AppLayout のグローバルショートカット競合を回避):
 * - ArrowRight / Space / PageDown / n / j → 次のスライド
 * - ArrowLeft / PageUp / Backspace / p / k → 前のスライド
 * - Home → 先頭 / End → 末尾
 * - Esc → onClose
 */
export function SlideShowOverlay({ slides, startIndex, onClose }: SlideShowOverlayProps) {
	// slides は parseSlides の契約上 1 件以上返るはずだが、テスト用途で空配列が
	// 渡されても "1 / 0" 表示や index=-1 にならないよう単一の空スライドで補う。
	const safeSlides = useMemo(
		() => (slides.length > 0 ? slides : [{ content: "", from: 0, to: 0 }]),
		[slides],
	);
	// startIndex が範囲外 (呼び出し側で clamp 漏れ) でも安全にクランプする。
	// slides は F5 押下時の snapshot で mount 中は変化しないため再 clamp effect は不要。
	const [index, setIndex] = useState(() =>
		Math.max(0, Math.min(startIndex, safeSlides.length - 1)),
	);

	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	// 全スライドを事前レンダーしてナビゲーション時の markdownToHtml/KaTeX 再計算を回避。
	const htmls = useMemo(
		() => safeSlides.map((s) => renderSlideHtml(s.content, activeTabPath)),
		[safeSlides, activeTabPath],
	);

	useEffect(() => {
		const next = () => setIndex((i) => Math.min(i + 1, safeSlides.length - 1));
		const prev = () => setIndex((i) => Math.max(i - 1, 0));
		// キー → アクションのテーブル。素押しでのみ発火するグループ (n/j/p/k) は
		// meta/ctrl/alt 修飾を弾いた後に、`toLowerCase()` で CapsLock/Shift 併用にも
		// マッチさせる。
		const nav: Record<string, () => void> = {
			Escape: onClose,
			ArrowRight: next,
			PageDown: next,
			" ": next,
			ArrowLeft: prev,
			PageUp: prev,
			Backspace: prev,
			Home: () => setIndex(0),
			End: () => setIndex(safeSlides.length - 1),
		};
		const plain: Record<string, () => void> = { n: next, j: next, p: prev, k: prev };
		const handler = (e: KeyboardEvent) => {
			// IME 確定中は無視 (composition 中の Enter/Esc を発表ナビにしない)。
			if (e.isComposing) return;
			const action =
				nav[e.key] ??
				(!e.metaKey && !e.ctrlKey && !e.altKey ? plain[e.key.toLowerCase()] : undefined);
			if (!action) return;
			e.preventDefault();
			e.stopPropagation();
			action();
		};
		document.addEventListener("keydown", handler, true);
		return () => document.removeEventListener("keydown", handler, true);
	}, [onClose, safeSlides.length]);

	const { ref: stageRef, scale } = useFitScale<HTMLDivElement>(
		SLIDE_LOGICAL_WIDTH,
		SLIDE_LOGICAL_HEIGHT,
	);

	return (
		<div
			className="slide-show-overlay fixed inset-0 z-50 flex flex-col bg-black"
			role="dialog"
			aria-label="スライド発表モード"
			aria-modal="true"
		>
			<div
				ref={stageRef}
				className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
			>
				<SlideFrame
					scale={scale}
					html={htmls[index] ?? ""}
					frameClassName="bg-white shadow-2xl dark:bg-[#2a2a2a]"
				/>
			</div>
			<div className="pointer-events-none absolute bottom-4 right-4 rounded bg-black/60 px-3 py-1 text-sm text-white">
				{index + 1} / {safeSlides.length}
			</div>
			<button
				type="button"
				onClick={onClose}
				className="absolute right-4 top-4 rounded bg-black/60 px-3 py-1 text-sm text-white hover:bg-black/80"
				aria-label="発表モードを終了 (Esc)"
			>
				終了 (Esc)
			</button>
		</div>
	);
}
