/**
 * 実行時の OS 判定をプロジェクト共通で 1 箇所に集約する。
 *
 * 過去に `MarkdownEditor.tsx` / `links.ts` / `NewTabContent.tsx` / `HelpDialog.tsx`
 * 等で `navigator.platform` を `.includes("Mac")` だったり
 * `.toLowerCase().includes("mac")` だったり `userAgent` 経由だったりとバラついて
 * いた。検出ロジックを散らさず、ここからだけ import する。
 *
 * `navigator.platform` は deprecated 寄りだが Electron 環境では安定して使える
 * （ipc/main から userAgent を流すより軽い）。jsdom 環境では `""` を返すので
 * 非 Mac 扱いになる点だけ注意。
 */
export const IS_MAC =
	typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

/** UI ラベル用の primary modifier 表記。Mac は ⌘、それ以外は Ctrl+。 */
export const PRIMARY_MOD_SYMBOL = IS_MAC ? "⌘" : "Ctrl+";

/** Kbd 単位表示用の modifier ラベル。Mac は ⌘、それ以外は Ctrl。 */
export const MOD_KEY_LABEL = IS_MAC ? "⌘" : "Ctrl";
/** Kbd 単位表示用の Shift ラベル。Mac は ⇧、それ以外は Shift。 */
export const SHIFT_KEY_LABEL = IS_MAC ? "⇧" : "Shift";
