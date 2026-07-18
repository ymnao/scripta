import { type RefObject, useEffect } from "react";

type Axis = "x" | "y";

interface Options {
	/** スクロール軸。default は "y" (縦方向のリスト、CommandPalette 等)。 */
	axis?: Axis;
	/** scrollBy の behavior。default は "auto" (瞬時)。smooth を明示するとアニメーション。 */
	behavior?: ScrollBehavior;
}

/**
 * container の `children[activeIndex]` が可視範囲外にある時、container-local な
 * scrollBy で最小移動して収める。祖先要素まで scroll する `Element.scrollIntoView`
 * と違い、container 内に閉じる (ページ全体が動かない)。
 *
 * 使用側は container 要素に ref を貼り、直接子として index 順に選択候補を並べる
 * (例: CommandPalette の listbox / SlideThumbnails の nav)。activeIndex >= children.length
 * の場合は自動的に early return する。delta=0 で short-circuit。
 */
export function useScrollActiveChildIntoView(
	containerRef: RefObject<HTMLElement | null>,
	activeIndex: number,
	options?: Options,
): void {
	const axis = options?.axis ?? "y";
	const behavior = options?.behavior ?? "auto";
	useEffect(() => {
		const container = containerRef.current;
		const child = container?.children[activeIndex] as HTMLElement | undefined;
		if (!container || !child) return;
		const containerRect = container.getBoundingClientRect();
		const childRect = child.getBoundingClientRect();
		const [start, end, containerStart, containerEnd] =
			axis === "x"
				? [childRect.left, childRect.right, containerRect.left, containerRect.right]
				: [childRect.top, childRect.bottom, containerRect.top, containerRect.bottom];
		const delta =
			start < containerStart ? start - containerStart : end > containerEnd ? end - containerEnd : 0;
		if (!delta) return;
		// ScrollToOptions の left/top を静的に区別することで typo / axis 順序ミスを typecheck が拾えるようにする
		container.scrollBy(axis === "x" ? { left: delta, behavior } : { top: delta, behavior });
	}, [containerRef, activeIndex, axis, behavior]);
}
