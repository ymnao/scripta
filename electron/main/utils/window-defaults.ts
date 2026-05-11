import type { BrowserWindowConstructorOptions } from "electron";

// メインウィンドウ専用の title bar 設定。`src/components/editor/TabBar.tsx` のタブ高
// `h-9` (36px) に traffic light を上下中央寄せする (12px button を center 18px に置く
// ため y = 12)。タブ高を変える際はここも追従させる。
//
// 他のウィンドウ（コンフリクト解消等）は drag region もタブストリップも持たないため、
// この定数を流用すると traffic light 位置が文脈に合わない。各ウィンドウで個別に
// `titleBarStyle` のみを inline 指定し、`trafficLightPosition` は macOS デフォルトに任せる。
export const MAIN_WINDOW_TITLE_BAR_OPTIONS = {
	titleBarStyle: "hiddenInset",
	trafficLightPosition: { x: 16, y: 12 },
} as const satisfies Pick<
	BrowserWindowConstructorOptions,
	"titleBarStyle" | "trafficLightPosition"
>;
