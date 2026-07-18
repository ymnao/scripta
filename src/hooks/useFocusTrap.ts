import { type RefObject, useEffect } from "react";

// button/input 等は selector 段階で disabled を除外する (ネイティブ Tab 順序と一致させる)。
// [tabindex] は "-1" しか CSS 属性セレクタで除外できないので、"-2" 以下は取得後に
// `.tabIndex >= 0` でフィルタする (querySelectorAll の段階では拾われる)。
const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusables(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) => el.tabIndex >= 0,
	);
}

/**
 * container 内で Tab / Shift+Tab の focus 循環をトラップする。role="dialog"
 * aria-modal="true" な overlay (DialogBase / SlideShowOverlay / CommandPalette)
 * で背後のエディタへ Tab が抜けるのを防ぐ。
 *
 * `document` 全体で keydown を購読し、
 * - activeElement が container 外 / container 自身 → 強制的に container 内 (先頭または末尾) へ移す
 * - activeElement が first で Shift+Tab → last へラップ
 * - activeElement が last で Tab → first へラップ
 * - focusable が 0 件でも Tab を preventDefault して modal を維持する
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
			const focusables = getFocusables(container);
			const activeEl = document.activeElement as HTMLElement | null;
			const inContainer = !!activeEl && activeEl !== container && container.contains(activeEl);
			if (focusables.length === 0) {
				// focusable が 0 でも Tab を素通しさせない (modal 外へ焦点が抜けるのを防ぐ)。
				e.preventDefault();
				return;
			}
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			if (!inContainer) {
				// container 自身 / container 外に focus がある時は逆端へ吸い込む。
				e.preventDefault();
				(e.shiftKey ? last : first).focus();
				return;
			}
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
