import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * 論理サイズ (logicalWidth × logicalHeight) の要素を、`ref` を貼った親要素の
 * 内側にアスペクト比維持で fit させる `scale` を返す。
 *
 * 使用側: `ref` を親コンテナに貼り、子要素に `transform: scale(scale)`
 * (と `origin-top-left`) を適用する。
 *
 * useLayoutEffect + 同期 update() で初回描画から正しい scale にする
 * (scale=1 の初期値で 1 フレーム描いてから setState でジャンプする flash を回避)。
 * ResizeObserver からの通知は rAF で 1 フレーム分に coalesce し、
 * splitter drag 中の連続再レンダーを 60fps に抑える。
 *
 * jsdom には ResizeObserver がないため、テストでは test-setup 側で no-op mock を注入する。
 */
export function useFitScale<T extends HTMLElement>(
	logicalWidth: number,
	logicalHeight: number,
): { ref: RefObject<T | null>; scale: number } {
	const ref = useRef<T | null>(null);
	const [scale, setScale] = useState(1);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const update = () => {
			const w = el.clientWidth;
			const h = el.clientHeight;
			if (w <= 0 || h <= 0) return;
			setScale(Math.min(w / logicalWidth, h / logicalHeight));
		};
		update();
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
	}, [logicalWidth, logicalHeight]);

	return { ref, scale };
}
