/**
 * Cross-OS primary modifier (Cmd on macOS / Ctrl on other platforms) 判定。
 *
 * `KeyboardEvent` / `MouseEvent` / React の合成イベント / テスト fixture のいずれも
 * `metaKey` / `ctrlKey` を持つため、最小の構造で受ける。OS 判定は行わず、Mac 上での
 * Ctrl+click や Win 上での Cmd 相当 (仮想キー) も許容する (旧 AppLayout / FileTreeItem /
 * MermaidEditorDialog / table-decoration の挙動と一致)。
 *
 * OS 依存で片方だけを許可する必要があるケース (例: リンク Cmd+click は Mac の Ctrl+click
 * を context menu 用に除外したい) は `src/lib/platform.ts` の `IS_MAC` を使い、この helper
 * ではなく専用ロジックを組む (`live-preview/links.ts` の `decideOpenLinkModifier` を参照)。
 */
export const cmdOrCtrl = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
	e.metaKey || e.ctrlKey;
