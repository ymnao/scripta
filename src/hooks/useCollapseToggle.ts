import { useCallback, useState } from "react";

interface UseCollapseToggleReturn {
	isCollapsed: (key: string) => boolean;
	toggle: (key: string) => void;
	reset: () => void;
}

/** Key 集合で collapsed 状態を管理する hook (panel UI 用)。 */
export function useCollapseToggle(): UseCollapseToggleReturn {
	// 初期値は lazy init で 1 度だけ評価する。`new Set()` 直渡しは毎 render で
	// 捨てられる Set を allocation するため、頻繁に再 render する consumer (検索入力中の
	// SearchPanel 等) でも無駄を減らす。
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

	const toggle = useCallback((key: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	// useCallback で包んでも deps の `collapsed` が toggle ごとに変わるため reference は
	// 安定しない。consumer 側も deps 配列に渡さないので、inline arrow で十分。
	const isCollapsed = (key: string) => collapsed.has(key);

	// state が既に空なら同じ参照を返して re-render を抑制する。BacklinkPanel の
	// useEffect が target 切替の度に reset を呼ぶため、何も折り畳まれていない通常状態
	// での無駄な re-render を回避する。
	const reset = useCallback(() => setCollapsed((prev) => (prev.size === 0 ? prev : new Set())), []);

	return { isCollapsed, toggle, reset };
}
