# Tauri purge inventory

> **目的**: 旧 Tauri 版 surface（Rust コマンド + frontend `@tauri-apps/*` API）の **逆引き**、および新版コードに残存する Tauri / WKWebView 言及の **正引き** を網羅し、Phase 2-5 の削除・置換作業を漏れなく見積もるためのインベントリ。
>
> Issue #82 (Tauri 完全除去 Phase 1) のサブタスク A + B の成果物。
>
> 本ドキュメント自体は Phase 2-5 完了時点で **dead artifact** となることを是とする。Phase 5 完了時に削除 (または `docs/archive/` 移動) を別 Issue で扱う。

---

## 1. 逆引きインベントリ — 旧 Tauri 版 surface → 新版

### 1.1 Rust `invoke_handler!` 32 コマンド

旧版 `/Users/nakiym/development/tools/scripta/src-tauri/src/lib.rs::invoke_handler!` 登録順。新版 IPC channel は `electron/preload/index.ts` を、ハンドラは `electron/main/ipc/*.ts` を参照。

#### File 系 (10)

| # | 旧 invoke (snake_case) | 旧モジュール | 新 IPC channel | 新ハンドラ |
|---|---|---|---|---|
| 1 | `read_file` | `commands::file` | `fs:read` | `electron/main/ipc/fs.ts` |
| 2 | `write_file` | `commands::file` | `fs:write` | 同上 |
| 3 | `write_new_file` | `commands::file` | `fs:write-new` | 同上 |
| 4 | `create_file` | `commands::file` | `fs:create-file` | 同上 |
| 5 | `create_directory` | `commands::file` | `fs:create-directory` | 同上 |
| 6 | `rename_entry` | `commands::file` | `fs:rename` | 同上 |
| 7 | `delete_entry` | `commands::file` | `fs:delete` | 同上 |
| 8 | `show_in_folder` | `commands::file` | `shell:show-in-folder` | `electron/main/ipc/shell.ts` |
| 9 | `path_exists` | `commands::file` | `fs:path-exists` | `electron/main/ipc/fs.ts` |
| 10 | `file_exists` | `commands::file` | `fs:file-exists` | 同上 |

#### Workspace / Watcher 系 (3)

| # | 旧 invoke | 旧モジュール | 新 IPC channel | 新ハンドラ |
|---|---|---|---|---|
| 11 | `list_directory` | `commands::workspace` | `fs:list` | `electron/main/ipc/fs.ts`（`opts` 引数追加） |
| 12 | `start_watcher` | `commands::watcher` | `watcher:start` | `electron/main/ipc/watcher.ts` |
| 13 | `stop_watcher` | `commands::watcher` | `watcher:stop` | 同上 |

#### Search 系 (3)

| # | 旧 invoke | 旧モジュール | 新 IPC channel | 新ハンドラ |
|---|---|---|---|---|
| 14 | `search_files` | `commands::search` | `search:files` | `electron/main/ipc/search.ts` |
| 15 | `search_filenames` | `commands::search` | `search:filenames` | 同上 |
| 16 | `scan_unresolved_wikilinks` | `commands::search` | `search:unresolved-wikilinks` | 同上 |

#### OGP / Export 系 (2)

| # | 旧 invoke | 旧モジュール | 新 IPC channel | 新ハンドラ |
|---|---|---|---|---|
| 17 | `fetch_ogp` | `commands::ogp` | `ogp:fetch` | `electron/main/ipc/ogp.ts` |
| 18 | `export_pdf` | `commands::export` | `pdf:export` | `electron/main/ipc/pdf.ts` |

#### Git 系 (12)

| # | 旧 invoke | 旧モジュール | 新 IPC channel | 新ハンドラ |
|---|---|---|---|---|
| 19 | `git_check_available` | `commands::git_sync` | `git:check-available` | `electron/main/ipc/git.ts` |
| 20 | `git_check_repo` | `commands::git_sync` | `git:check-repo` | 同上 |
| 21 | `git_status` | `commands::git_sync` | `git:status` | 同上 |
| 22 | `git_add_all` | `commands::git_sync` | `git:add-all` | 同上 |
| 23 | `git_commit` | `commands::git_sync` | `git:commit` | 同上 |
| 24 | `git_pull` | `commands::git_sync` | `git:pull` | 同上 |
| 25 | `git_push` | `commands::git_sync` | `git:push` | 同上 |
| 26 | `git_get_conflicted_files` | `commands::git_sync` | `git:get-conflicted-files` | 同上 |
| 27 | `git_get_conflict_content` | `commands::git_sync` | `git:get-conflict-content` | 同上 |
| 28 | `git_resolve_conflict` | `commands::git_sync` | `git:resolve-conflict` | 同上 |
| 29 | `git_finish_conflict_resolution` | `commands::git_sync` | `git:finish-conflict-resolution` | 同上 |
| 30 | `git_get_last_commit_time` | `commands::git_sync` | `git:get-last-commit-time` | 同上 |

#### Updater / WebView 系 (2)

| # | 旧 invoke | 旧モジュール | 新 IPC channel | 新ハンドラ |
|---|---|---|---|---|
| 31 | `check_for_update` | `commands::updater` | `update:check` | `electron/main/ipc/update.ts` |
| 32 | `clear_webview_browsing_data` | `commands::lib.rs`（top-level） | `window:clear-webview-data` | `electron/main/ipc/window.ts` |

**カバレッジ**: 32 / 32 全 command が新版 IPC channel で代替済み（欠落なし）。

#### 旧 Tauri 側にのみ存在 / 新版で消えた仕掛け

`invoke_handler!` には現れないが、旧 lib.rs の setup ブロックで作っていた状態管理は以下:

- `tauri_plugin_window_state` — ウィンドウサイズ/位置の永続化 → 新版は `electron/main/utils/window-state.ts` で自前実装
- `tauri_plugin_store` — `settings.json` の永続化 → 新版は `electron/main/ipc/settings.ts`（同名 file format で互換維持）
- `tauri_plugin_shell` — `open()` 外部 URL → 新版は `shell.openExternal` 経由 (`shell:open-external` channel)
- `tauri_plugin_dialog` — file/save dialog → 新版は `electron/main/ipc/dialog.ts` (`dialog:open-directory` / `dialog:save`)
- `tauri_plugin_log` — debug log → 新版では未移植（標準 console / electron-log 等が必要なら別 Issue）
- `WebViewCacheClearState` + `check_and_clear_cache` — version bump 時の WebView キャッシュクリア → Chromium は app 起動時に session.defaultSession.clearCache が利用可能。新版は **未実装**（Chromium 固定で WKWebView の deep cache 問題自体が消えたため不要、Phase 2 で削除確認対象）

### 1.2 旧 frontend `@tauri-apps/*` API → 新版 mapping

旧版 `/Users/nakiym/development/tools/scripta/src/` で使われていた import を新版 `window.api` / Web 標準 API への置換と対応付け。

| 旧 import | 旧用途 | 新 API | 備考 |
|---|---|---|---|
| `@tauri-apps/api/core::invoke` | Rust command 呼び出し | `window.api.<method>(…)` (`src/lib/commands.ts` ラッパー経由) | retry 層 (`withRetry`) は新版に引き継ぎ |
| `@tauri-apps/api/core::convertFileSrc` | path → `tauri://localhost/<path>` URL 変換 | `window.api.convertFileSrc` → `buildScriptaAssetUrl()` (`scripta-asset://` scheme) | **Phase 3 で `buildAssetUrl` にリネーム** |
| `@tauri-apps/api/event::listen` | OS / Rust 発の event 受信 | `ipcRenderer.on(channel, …)` を preload で `subscribe<T>()` ラップ | `window.api.onFsChange` / `onWorkspaceReloadTree` / `onConflictResolved` / `onMenuEvent` / `onWindowCloseRequested` 経由 |
| `@tauri-apps/api/event::emit` | window 間 event 送出 | `ipcRenderer.invoke("git:emit-conflict-resolved", …)` 経由で main が `webContents.send` で再配送 | `emitConflictResolved` ラッパー |
| `@tauri-apps/api/window::getCurrentWindow` | 現在の window 取得 / close | `window.api.closeWindow()` | 単一 method 化で simpler |
| `@tauri-apps/api/webviewWindow::WebviewWindow` | 二次 window (`conflict-resolver`) の生成 / 再オープン | `window.api.openConflictWindow(workspacePath)` | main 側で label による re-focus を実装 (`electron/main/ipc/window.ts`) |
| `@tauri-apps/api/app::getVersion` | アプリバージョン取得 | `window.api.getAppVersion()` → main の `app.getVersion()` | |
| `@tauri-apps/plugin-shell::open` | 外部 URL を OS ブラウザで開く | `window.api.openExternal(url)` → main の `shell.openExternal` | URL allowlist (`isSafeExternalUrl`) チェック付き |
| `@tauri-apps/plugin-dialog::open` | フォルダ選択ダイアログ | `window.api.openDirectoryPicker()` | |
| `@tauri-apps/plugin-dialog::save` | 保存先ダイアログ | `window.api.showSaveDialog(opts)` | |
| `@tauri-apps/plugin-store::load` + `Store` | 設定 `settings.json` の I/O | `window.api.settingsGet/Set/Delete/Save` | userData 互換維持判断は § 3 |

新版 `package.json` には `@tauri-apps/*` 依存はゼロ（`HANDOFF.md` / `docs/parity-checklist.md` 以外に `@tauri-apps` 文字列なし）。

---

## 2. 正引きインベントリ — 新版コード残骸

### 2.1 grep 条件

`git grep -niE` パターン:

```
tauri | wkwebview | __TAURI | webviewWindow | @tauri-apps | src-tauri
tauri:// | tauri-plugin | data-tauri- | convertFileSrc | WebviewWindow
appWindow | tauri.conf | WebKit
```

対象スコープ: `src/**` / `electron/**` / `electron-builder.yml` / `package.json` / `electron.vite.config.ts` / `biome.json` / `tsconfig*.json` / `vitest.config.ts` / `playwright.config.ts` / `.github/**`

### 2.2 集計

| 分類 | hit 数 | 説明 |
|---|---|---|
| **A** 純 dead code | 30+ 行 | Chromium 固定で常に false の分岐・関数 |
| **B** 構造的レガシー | 8 箇所 (6 ファイル) | `convertFileSrc` API 名 |
| **C** ドキュメンタリーコメント | 41 行 (31 ファイル) | 「旧 Tauri 版」「src-tauri」言及 |
| **D** false positive (保持) | 12 行 (6 ファイル) | `-webkit-` prefix だが Chromium 用 CSS |

合計 grep hit 数は約 90+ 行。これは Phase 2-5 の質的進捗指標として `scripts/check-tauri-residue.sh` (Phase 1 PR-2) で監視する。

### 2.3 A: 純 dead code (削除可) — Phase 2 担当

#### A-1. `isTauriProtocol` 分岐と関連 Mermaid 処理

`window.location.protocol === "tauri:"` は Chromium 固定で常に false。依存する関数 (`patchTextAnchor` / `bakeStyledSvg` / `promoteMermaidStyles` / `htmlLabels: false` 強制) も全 dead。

| ファイル | 行 | 内容 |
|---|---|---|
| `src/lib/mermaid.ts` | 15-17 | `isTauriProtocol` 定義 |
| `src/lib/mermaid.ts` | 27-60, 188-208, 230-248, 336, 345 | `patchTextAnchor` / 関連 init オプション / call site |
| `src/lib/mermaid.ts` | 388-510 | `bakeStyledSvg` / `promoteMermaidStyles` |
| `src/components/editor/live-preview/mermaid.ts` | 20, 126-161 | `isTauriProtocol` import + style/属性 ミラー分岐 |
| `src/components/editor/MermaidEditorDialog.tsx` | 3, 101 | dialog 側 `promoteMermaidStyles` 呼び出し |
| `src/components/editor/live-preview/mermaid.test.ts` | 9 | `isTauriProtocol: false` mock |
| `src/components/editor/MermaidEditorDialog.test.tsx` | 9 | 同上 |

**作業**: Phase 2 で `isTauriProtocol` を export と call site から削除し、依存する関数 (`patchTextAnchor` / `bakeStyledSvg` / `promoteMermaidStyles`) を export 解除 → unreferenced 化 → 削除。テストの mock 行も削除。`#93` PDF 再現確認は Phase 2 で挙動変化のリスクあり (Phase 4 完了後検証)。

#### A-2. `composingClass` ViewPlugin (WKWebView CJK IME 対策)

| ファイル | 行 | 内容 |
|---|---|---|
| `src/components/editor/editor-theme.ts` | 6-31 | `composingClass` ViewPlugin |

WKWebView の drawSelection 描画バグ回避用 (`.cm-selectionBackground` が IME composition 中に残る問題)。Chromium では再現しない見込み。

**作業**: Phase 2 で `composingClass` export を call site (editor extensions 配列) から外す → 削除。実機検証は safety net テスト (#82 C, CJK IME 領域) で baseline 化済み前提。

#### A-3. `markdown-to-html.ts` の lookbehind 回避

| ファイル | 行 | 内容 |
|---|---|---|
| `src/lib/markdown-to-html.ts` | 80-81 | inline code span 手動スキャン（lookbehind 回避） |

`(?<=...)` lookbehind が old WebKit で動かないため手動 backtick scan に展開していた。Chromium 固定なら lookbehind 利用可。

**作業**: Phase 2 (または Phase 3) で `(?<!`)`...` 系の regex に置換検討。優先度は低い（手動スキャンも正しく動いているため）。

### 2.4 B: 構造的レガシー (置換要) — Phase 3 担当

#### B-1. `convertFileSrc` API 名 (Tauri `@tauri-apps/api/core` 由来)

新版でも同名関数として残存。`buildScriptaAssetUrl` を内部呼び出ししているだけなので、preload の API 名・ラッパー名を `buildAssetUrl` (HANDOFF 既定) にリネームすれば波及は限定的。

| ファイル | 行 | 内容 |
|---|---|---|
| `electron/preload/api.ts` | 33 | `convertFileSrc: (path: string) => string;` 型宣言 |
| `electron/preload/index.ts` | 40 | 実装 (`buildScriptaAssetUrl(path)` を返すだけ) |
| `src/lib/commands.ts` | 193-195 | renderer 側 wrapper `convertFileSrc` |
| `src/__test-utils__/api-mock.ts` | 21 | test mock |
| `src/components/editor/live-preview/images.ts` | 12, 41, 53 | call sites (`import { convertFileSrc }`) |
| `src/components/editor/live-preview/images.test.ts` | 6, 8, 62, 70, 77 | テスト mock + テスト名 |

**作業**: Phase 3 で `convertFileSrc` → `buildAssetUrl` 一括リネーム。テスト名 (`"converts Unix absolute path via convertFileSrc"` 等) も書き換え。

### 2.5 C: ドキュメンタリーコメント (完全削除) — Phase 3 担当

「旧 Tauri 版」/「src-tauri」/「tauri-plugin-store」/「`{ payload }` 形式」等の言及。**完全削除方針** (marker convention は採用せず、必要な根拠は `docs/adr/` に集約)。

`electron/main/ipc/git.ts:15` の例:
- ❌ 削除前: `// 旧 Tauri 版 src-tauri/src/commands/git_sync.rs を simple-git ベースで 1:1 port。`
- ✅ 削除後: コメント自体を削除（仕様だけ別行に残す場合は `// simple-git ベースで git 操作を集約。`）

| ファイル | hit 行 | 件数 | メモ |
|---|---|---|---|
| `electron-builder.yml` | 1 | 1 | bundle ID 互換 |
| `electron/main/index.ts` | 16, 30, 96 | 3 | userData 互換 (§ 3 判断あり) / asset scheme / newWindow |
| `electron/main/ipc/git.ts` | 15, 100 | 2 | port / Err 経路 |
| `electron/main/ipc/ogp.ts` | 8 | 1 | port |
| `electron/main/ipc/pdf.test.ts` | 185 | 1 | TIMEOUT_SECS 同期 |
| `electron/main/ipc/pdf.ts` | 10, 11, 41, 164 | 4 | port / 5 分予算 |
| `electron/main/ipc/search.ts` | 104 | 1 | port |
| `electron/main/ipc/settings.test.ts` | 118 | 1 | `Option<Value>` 互換 |
| `electron/main/ipc/settings.ts` | 120 | 1 | 同上 |
| `electron/main/ipc/update.ts` | 6, 12 | 2 | port |
| `electron/main/ipc/watcher.ts` | 16 | 1 | WatcherState 前提 |
| `electron/main/ipc/window.ts` | 7, 46 | 2 | `WebviewWindow.getByLabel` 互換 / `parent` |
| `electron/main/ipc/workspace.ts` | 47 | 1 | newWindow 仕様参照 |
| `electron/main/menu.test.ts` | 151 | 1 | 1:1 言及 |
| `electron/main/menu.ts` | 4, 18, 39, 83 | 4 | setup_menu / focused / accelerator / View メニュー |
| `electron/main/utils/fs-errors.ts` | 1 | 1 | **Phase 5 で本体ごと structured error 化、コメント削除と同時** |
| `electron/main/utils/git-env.ts` | 4, 49 | 2 | git_command 集約 |
| `electron/main/utils/git-validators.ts` | 3 | 1 | validator port |
| `electron/main/utils/ogp-parser.ts` | 3 | 1 | parse port |
| `electron/main/utils/semver-lite.ts` | 1 | 1 | semver crate サブセット |
| `electron/main/utils/ssrf-guard.ts` | 5 | 1 | ssrf port |
| `src/components/editor/TabBar.tsx` | 12-13 | 2 | `data-tauri-drag-region` 非動作言及 |
| `src/components/layout/AppLayout.test.tsx` | 103 | 1 | `{ payload }` 形式言及 |
| `src/index.css` | 81 | 1 | WKWebView compat 言及 |
| `src/lib/ime.ts` | 4 | 1 | Safari/WebKit compositionend 言及 (Chromium でも該当する仕様、コメント書換でロジック保持) |
| `src/lib/path.test.ts` | 44 | 1 | Tauri uses consistent separators |
| `src/stores/theme.ts` | 20 | 1 | tauri-plugin-store 言及 |

**作業**: Phase 3 で各コメントを削除 (仕様だけ残す書き換え or 完全削除)。`ime.ts:4` は **ロジック保持・コメント書換のみ**（Safari/WebKit でも該当する正当な仕様だが、Tauri に紐付けて読ませる必要はない）。

### 2.6 D: false positive (保持) — Phase 6 で部分検討

`-webkit-` prefix は Chromium も使用するため、以下は Tauri/WKWebView 残骸ではない。CI ガード (PR-2) では grep 除外パターンに追加する。

| ファイル | 行 | 内容 | 判定 |
|---|---|---|---|
| `src/components/editor/editor-theme.ts` | 385-387 | `-webkit-box` / `WebkitLineClamp` / `WebkitBoxOrient` | line clamp、Chromium 用、保持 |
| `src/components/editor/TabBar.tsx` | 14-15 | `WebkitAppRegion: "drag" / "no-drag"` | Electron frameless ドラッグ領域、必須、保持 |
| `src/types/css.d.ts` | 1-8 | `WebkitAppRegion` の型宣言 | 同上、必須、保持 |
| `src/index.css` | 26 | `-webkit-font-smoothing: antialiased` | フォント描画、保持 |
| `src/components/layout/NewTabContent.tsx` | 51-52 | `WebkitBackgroundClip` / `WebkitTextFillColor` | gradient text、保持 |
| `src/lib/export.ts` | 423 | `-webkit-print-color-adjust: exact` | 印刷時の色保持、必須、保持 |

`src/lib/export.ts:496` — `:has()` 古い WebKit 対応の言及。Chromium 105+ で `:has()` 利用可、Electron 42 (Chromium 134) は完全対応。**Phase 6** (ビルド最適化) で `:has(input)` selector ベースに書き換え検討。

---

## 3. Settings migration 互換維持 / 撤去判断

`electron/main/index.ts:37-39` で以下を実行:

```ts
if (app.isPackaged) {
  app.setName("scripta");
}
```

旧 Tauri 版の `~/Library/Application Support/scripta/` (productName = "scripta") を新版が継続利用するためのブリッジ。package.json:name は `scripta-next` のままなので、`app.isPackaged` 時のみ上書きすることで pnpm dev は新版独自の userData (`scripta-next`) を使う仕掛けになっている。

### 選択肢

| 案 | 説明 | 影響 |
|---|---|---|
| **A. 互換維持** | 現状維持。`setName("scripta")` を残し、旧版ユーザーの設定 (`workspacePath` / `themePreference` / window state 等) を継続利用 | 旧 Tauri 版が同 userData に同時アクセス中は競合リスク (現実的には同時起動禁止扱い)。`docs/parity-checklist.md:192` と整合 |
| **B. 撤去** | `setName` 削除。新版は `scripta-next` 名で fresh userData。手動移行 doc を提供 | code は simpler だが旧版ユーザーが workspacePath 等を再設定必要。旧版が並走稼働する移行期間は user-hostile |

### 判定

**当面 A (互換維持) を採用**。理由:

- 旧 Tauri 版が v0.2.0 リリース後も並走稼働する前提 (`CLAUDE.md` 「移行完了まで稼働継続」)
- `setName` の 1 行で互換性を維持できるコストの低さ
- 撤去は v1.0.0 リネーム (#28) と同タイミング (リポジトリ名・productName を `scripta` に正規化する流れで、`scripta-next` → `scripta` の userData 移行を明示) が自然

### Phase 3 への引き継ぎ

`electron/main/index.ts:30-36` のコメント (4 行) は Phase 3 でコメント削除対象になるが、削除と同時に **ADR-0001 「旧 Tauri 版 userData の互換維持と撤去タイミング」** を起こし、根拠を恒久記録する。本ドキュメントは dead artifact 化 (Phase 5 完了時) しても ADR は残る。

---

## 関連

- Issue: **#82** (Tauri 完全除去 Phase 1)
- 親 Issue: **#81** (Tauri purge トラッカー)
- 後続: #83 (Phase 2 削除) / #84 (Phase 3 置換) / #85 (Phase 5 design smell) / #86 (Phase 4 テスト精査) / #87 (Phase 6 ビルド最適化)
- 旧リポジトリ: https://github.com/ymnao/scripta
