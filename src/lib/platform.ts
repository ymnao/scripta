/**
 * 実行時の OS 判定をプロジェクト共通で 1 箇所に集約する。
 *
 * 過去に `MarkdownEditor.tsx` / `links.ts` / `NewTabContent.tsx` / `HelpDialog.tsx`
 * 等で `navigator.platform` を `.includes("Mac")` だったり
 * `.toLowerCase().includes("mac")` だったり `userAgent` 経由だったりとバラついて
 * いた。検出ロジックを散らさず、ここからだけ import する。
 *
 * このポリシーは `plugins/no-navigator-platform*.grit` の Biome plugin 群で機械的
 * に強制されている。このファイル以外で `navigator.userAgent` / `navigator.platform`
 * を以下のいずれの形で参照しても lint エラーになる:
 *
 *   - dot access:        navigator.platform   / navigator.userAgent
 *   - optional chain:    navigator?.platform  / navigator?.userAgent
 *   - bracket access:    navigator["platform"] (' / " いずれも)
 *   - optional bracket:  navigator?.["platform"]
 *   - namespace prefix:  window.navigator.platform / globalThis.navigator.* / self.navigator.*
 *   - const destruct:    const { platform } = navigator  (shorthand / alias / multi-prop すべて)
 *   - var destruct:      var { platform } = navigator    (同上)
 *
 * marzano-Biome 2.4.16 の制約で **検出できない既知の穴** (= known limitation):
 *   - `let { ... } = navigator` の destructuring
 *     → 多くの場合 Biome 内蔵の `useConst` rule で warning が出る
 *   - `window.navigator?.platform` のような optional + 名前空間プレフィックスの合成
 *   - `const x = navigator; x.platform` のような中間変数経由のエイリアス
 *
 * 上記の限界は PR レビューでも明示的に確認すること。
 *
 * `navigator.platform` は deprecated 寄りだが Electron 環境では安定して使える
 * （ipc/main から userAgent を流すより軽い）。jsdom 環境では `""` を返すので
 * 非 Mac 扱いになる点だけ注意。
 */
export const IS_MAC =
	typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

/**
 * Windows 判定。`IS_MAC` と同じく `navigator.platform` 経由で評価する。
 * `navigator.platform` は "Win32" / "Win64" / "Windows" / "WinCE" 等の表記揺れが
 * あるため `/^Win/i` で先頭一致する（`/win/i` だと "Darwin" にもマッチしてしまう）。
 */
export const IS_WINDOWS = typeof navigator !== "undefined" && /^Win/i.test(navigator.platform);

/**
 * 後続キーと連結する文字列用の primary modifier 表記
 * （例: `${PRIMARY_MOD_SYMBOL}V` → "⌘V" / "Ctrl+V"）。
 * `<Kbd>` で 1 キーずつ表示する場合は MOD_KEY_LABEL の方を使う。
 */
export const PRIMARY_MOD_SYMBOL = IS_MAC ? "⌘" : "Ctrl+";

/**
 * 後続キーと連結する Shift + primary modifier 表記
 * （例: `${SHIFT_MOD_SYMBOL}X` → "⇧⌘X" / "Ctrl+Shift+X"）。
 * `SHIFT_KEY_LABEL` + `PRIMARY_MOD_SYMBOL` を直接連結すると Win で
 * `ShiftCtrl+X` のように区切り `+` が欠落するため、専用 prefix を用意する。
 * 順序は Mac の慣習 `⇧⌘`、Win の慣習 `Ctrl+Shift+` を採用し、
 * `<Kbd>` 配列 `[MOD, SHIFT, key]` の表示順とも一致させる。
 */
export const SHIFT_MOD_SYMBOL = IS_MAC ? "⇧⌘" : "Ctrl+Shift+";

/** `<Kbd>` で 1 キーずつ表示する用の modifier ラベル（連結用は PRIMARY_MOD_SYMBOL）。 */
export const MOD_KEY_LABEL = IS_MAC ? "⌘" : "Ctrl";
/** `<Kbd>` で 1 キーずつ表示する用の Shift ラベル。 */
export const SHIFT_KEY_LABEL = IS_MAC ? "⇧" : "Shift";
