import type { BrowserWindowConstructorOptions } from "electron";

// `src/components/editor/TabBar.tsx` のタブ高 `h-9` (36px) に合わせて traffic light を
// 上下中央寄せする。12px button を center 18px (= 36/2) に置くため y = 12。
// タブ高を変える際はここも追従させる。
export const TITLE_BAR_OPTIONS = {
	titleBarStyle: "hiddenInset",
	trafficLightPosition: { x: 16, y: 12 },
} as const satisfies Pick<
	BrowserWindowConstructorOptions,
	"titleBarStyle" | "trafficLightPosition"
>;
