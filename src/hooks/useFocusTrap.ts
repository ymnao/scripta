import { type RefObject, useEffect } from "react";

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * container 内で Tab / Shift+Tab の focus 循環をトラップする。role="dialog"
 * aria-modal="true" な overlay (DialogBase / SlideShowOverlay / CommandPalette)
 * で背後のエディタへ Tab が抜けるのを防ぐ。
 *
 * `document` 全体で keydown を購読し、activeElement が container 内の最初/最後の
 * focusable かを見て逆端へラップする。`disabled` 属性を持つ button/input/select/
 * textarea は selector で除外 (ネイティブ Tab 動作と一致させないと first/last の
 * 位置がズレる)。
 *
 * enabled=false の間は listener を張らない (dialog 未 open 時など)。
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, enabled = true): void {
	useEffect(() => {
		if (!enabled) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key !== "Tab") return;
			const container = containerRef.current;
			if (!container) return;
			const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
			if (focusables.length === 0) return;
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			const activeEl = document.activeElement as HTMLElement | null;
			if (e.shiftKey && activeEl === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && activeEl === last) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [enabled, containerRef]);
}
