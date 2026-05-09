# 機能パリティ確認チェックリスト（Tauri → Electron）

> Stage 6 完了判定の一部。本リポジトリ（Electron 版）が旧 `ymnao/scripta`（Tauri 版、`/Users/nakiym/development/tools/scripta`）と同等以上であることを、リリース切り替え前に検証する。
>
> 各項目には **状態ラベル**（✅ 移植済 / 🟡 要実機検証 / ⚠️ 既知差分 / ⛔ 未実装）と参照ファイルパスを記載する。

## 0. 凡例

- **✅ 移植済**: 実装が存在し、Vitest / Playwright（renderer-only）でカバー済み
- **🟡 要実機検証**: 実装は存在するが、`pnpm dist` パッケージビルドで動作確認が必要（renderer-only e2e ではカバーできない領域）
- **⚠️ 既知差分**: 旧版と挙動が異なることが判明している。要判断（許容 / 修正）
- **⛔ 未実装**: 旧版に存在するが新版未着手。リリース blocker 候補

参照基準:

- 旧 Tauri 版コマンド一覧: `/Users/nakiym/development/tools/scripta/src-tauri/src/lib.rs` の `invoke_handler!` ブロック（`commands::*` 31 個 + ルート定義の `clear_webview_browsing_data` で計 32）
- 旧フロント側プラグイン使用: `@tauri-apps/api/{core,event,window,webviewWindow,app}` / `@tauri-apps/plugin-{shell,dialog,store}`
- 新 Electron API 表面: `electron/preload/api.ts` の `Api` 型 + `electron/preload/index.ts` の `contextBridge.exposeInMainWorld`
- 新フロント呼び出し: `src/lib/commands.ts` を中心としたラッパー。ただし完全なフロント側 surface ではない点に注意。**`settings:*` 系のみ `src/lib/store.ts` から `window.api.settingsGet/Set/Delete/Save` を直接呼ぶ**（`commands.ts` を経由しない）。export 系（`src/lib/export.ts`）など他の機能はすべて `commands.ts` ラッパー経由なので、監査の索引としては「`commands.ts` + `store.ts`」の 2 箇所を見れば足りる

---

## 1. ファイル I/O（Stage 1）

| 旧コマンド | 新ハンドラ | 状態 | 備考 |
|---|---|---|---|
| `read_file` | `fs:read` | ✅ | `electron/main/ipc/fs.ts` / withRetry あり |
| `write_file` | `fs:write` | ✅ | withRetry あり |
| `write_new_file` | `fs:write-new` | ✅ | 既存上書き拒否を main 側で実装 |
| `create_file` | `fs:create-file` | ✅ | |
| `create_directory` | `fs:create-directory` | ✅ | |
| `rename_entry` | `fs:rename` | ✅ | withRetry あり |
| `delete_entry` | `fs:delete` | ✅ | `shell.trashItem` でゴミ箱移動 |
| `path_exists` | `fs:path-exists` | ✅ | |
| `file_exists` | `fs:file-exists` | ✅ | |
| `list_directory` | `fs:list` | ✅ | `electron/main/ipc/workspace.ts` |
| `show_in_folder` | `shell:show-in-folder` | ✅ | `electron/main/ipc/shell.ts` |

### 検証項目

- [ ] **🟡 path-guard 実機確認**: ワークスペース外パスへの read/write 試行を packaged build で main 側が拒否することを確認（Vitest ではモック越しの確認になりがち）
- [ ] **🟡 ゴミ箱移動の OS 別挙動**: macOS / Windows / Linux でゴミ箱に正しく移動するか（`shell.trashItem` は Linux で `gio trash` 依存）
- [ ] **🟡 リトライ挙動の確認**: 同時編集中の write 失敗 → 200ms / 400ms / 800ms の指数バックオフリトライが旧版と同等に効くか（`commands.ts` の `withRetry`）

---

## 2. ワークスペース・ファイルツリー・監視（Stage 2）

| 旧コマンド / API | 新ハンドラ | 状態 | 備考 |
|---|---|---|---|
| `list_directory`（再掲） | `fs:list` | ✅ | |
| `start_watcher` | `watcher:start` | ✅ | `chokidar` ベース、`electron/main/ipc/watcher.ts` |
| `stop_watcher` | `watcher:stop` | ✅ | |
| イベント `fs-change` (Tauri `listen`) | `onFsChange` | ✅ | `webContents.send` ベース |
| `open` (`@tauri-apps/plugin-dialog`、フォルダ選択) | `dialog:open-directory` | ✅ | `electron/main/ipc/dialog.ts:42-50` / **OS ネイティブ folder picker を通った path のみ `approveWorkspacePath` で main 側 approve リストに登録**。renderer が `workspace:set` を打つ際の信頼境界。`electron/main/ipc/dialog.test.ts` で IPC ハンドラ自体（cancel / 選択時の `approveWorkspacePath` 配線、`getOwnerWindow` の 4 段フォールバック）を直接検証 |

### 新版でのみ存在

- `workspace:set` IPC（旧版は frontend 側 `loadSettings/saveWorkspacePath` で完結）
  - 役割: main 側に "approve list" を構築し、path-guard の判定基盤として機能。
  - 設計判断: 旧版は path-guard 自体が Rust 側 fs プラグインの permission 経由で行われていたが、新版はメインプロセスの自前 path-guard 実装に置換。
  - 信頼境界: renderer から渡された任意の path は approve されない。OS ダイアログを経由した path のみ approve される（`dialog:open-directory` ハンドラ参照）。

### 検証項目

- [ ] **🟡 chokidar の large workspace 挙動**: 数千ファイル規模のワークスペースで watcher が安定して動くか（FSEvents / inotify の上限到達時のフォールバック確認）
- [ ] **🟡 fs-change イベント coalescing**: 連続書き込み時に旧版と同等の頻度で renderer に届くか（過剰イベントで UI が固まらないか）
- [ ] **🟡 Open Folder の信頼境界**: packaged build で Sidebar の "フォルダを開く" → OS ダイアログ → 選択 → workspace 復元までが旧版と同等に動くか。renderer から `workspace:set` に approve されていない任意 path を直接渡しても拒否されることを DevTools Console で確認

---

## 3. 全文検索（Stage 3）

| 旧コマンド | 新ハンドラ | 状態 | 備考 |
|---|---|---|---|
| `search_files` | `search:files` | ✅ | 純 JS で旧 Rust ロジックを 1:1 移植（`electron/main/ipc/search.ts`） |
| `search_filenames` | `search:filenames` | ✅ | |
| `scan_unresolved_wikilinks` | （`search:scan-unresolved-wikilinks` 等） | ✅ | |
| なし | `search:cancel` | ✅（新規追加） | 旧版にない cancellation API。`SearchPanel` の useEffect cleanup から呼ばれる |

### 検証項目

- [ ] **🟡 純 JS 検索性能**: 数千ファイル規模で旧 Rust と桁オーダー一致しているか体感確認（migration-plan.md の "将来課題" — ripgrep sidecar への置換は数万ファイル規模が顕在化してから）
- [ ] **🟡 İ / 絵文字 / 多バイト文字**: `electron/main/ipc/search.test.ts` で旧 Rust テスト相当が pass しているか再確認（git log で "Stage 3" コミットを参照）

### 既知差分

- ⚠️ 検索 cancel は新版のみ存在。旧版は in-flight 検索を await 完了するまで放置していた。UX 改善であり regression ではない。

---

## 4. Git Sync（Stage 4）

| 旧コマンド | 新ハンドラ | 状態 |
|---|---|---|
| `git_check_available` | `git:check-available` | ✅ |
| `git_check_repo` | `git:check-repo` | ✅ |
| `git_status` | `git:status` | ✅ |
| `git_add_all` | `git:add-all` | ✅ |
| `git_commit` | `git:commit` | ✅ |
| `git_pull` | `git:pull` | ✅ |
| `git_push` | `git:push` | ✅ |
| `git_get_conflicted_files` | `git:get-conflicted-files` | ✅ |
| `git_get_conflict_content` | `git:get-conflict-content` | ✅ |
| `git_resolve_conflict` | `git:resolve-conflict` | ✅ |
| `git_finish_conflict_resolution` | `git:finish-conflict-resolution` | ✅ |
| `git_get_last_commit_time` | `git:get-last-commit-time` | ✅ |

すべて `simple-git` ベースで再実装（`electron/main/ipc/git.ts`）。

### コンフリクト解決ウィンドウ

| 旧 | 新 | 状態 |
|---|---|---|
| `WebviewWindow` で `?conflict=true` を別ウィンドウとして開く | `window:open-conflict` IPC → main 側で別 BrowserWindow 生成 | ✅ |
| `emit('conflict-resolved', ...)` / `listen('conflict-resolved')` | `emitConflictResolved` / `onConflictResolved` IPC | ✅ |

### 検証項目

- [ ] **🟡 認証付き remote の pull/push**: SSH key / credential helper で旧版と同じ remote に push できるか（`simple-git` は子プロセスで `git` を呼ぶので環境依存が大きい）
- [ ] **🟡 packaged build での `git` 実行ファイル探索**: macOS の `/usr/bin/git` Xcode CLT 依存 / Windows の `git.exe` PATH 解決が旧版と同等か
- [ ] **🟡 コンフリクト解決ウィンドウの再フォーカス**: 既に開いているコンフリクトウィンドウを再度開こうとした時、旧版同等にフォーカスだけ戻るか（旧 `WebviewWindow.getByLabel("conflict-resolver")` の挙動）

---

## 5. OGP / エクスポート / 外部リンク（Stage 5）

### IPC コマンド

| 旧コマンド / API | 新ハンドラ | 状態 |
|---|---|---|
| `fetch_ogp` | `ogp:fetch` | ✅ `undici` + `cheerio`、SSRF 防御 |
| `export_pdf` | `pdf:export` | ✅ 隠し BrowserWindow + `webContents.printToPDF` |
| `open` (`@tauri-apps/plugin-shell`) | `shell:open-external` | ✅ scheme allowlist |
| `save` (`@tauri-apps/plugin-dialog`、保存先選択) | `dialog:save` | ✅ `electron/main/ipc/dialog.ts:52-60` / **`registerTransientWritePath` で window-scoped な短命 write capability を発行**（書き込み成功で consume、window close で cleanup）。これにより workspace 外への保存も path-guard を維持しつつ許可。`electron/main/ipc/dialog.test.ts` で IPC ハンドラ自体（cancel / 選択時の `registerTransientWritePath(sender.id, path)` 配線）を直接検証 |

### エクスポート機能（フロント実装）

旧版・新版ともに `src/lib/export.ts` + `src/components/common/ExportDialog.tsx` で 3 形式を提供。新版の export.ts はすべて `src/lib/commands.ts` のラッパー経由で IPC を呼ぶ（`exportPdf` / `showSaveDialog` / `writeFile` を import; `src/lib/export.ts:1`）。`window.api.*` を直接は叩かない。

| 形式 | 旧版 | 新版 | 状態 |
|---|---|---|---|
| **PDF** | `exportAsPdf` → `invoke("export_pdf")` | `exportAsPdf` → `commands.exportPdf` → `pdf:export` | ✅ |
| **HTML** | `exportAsHtml` → `plugin-dialog.save` + `plugin-fs.writeTextFile` | `exportAsHtml` → `commands.showSaveDialog` + `commands.writeFile` → `dialog:save`（transient write capability 発行）+ `fs:write`（path-guard 通過） | ✅ |
| **Prompt（.md）** | `exportAsPrompt` → `plugin-dialog.save` + `plugin-fs.writeTextFile` | `exportAsPrompt` → 同上（`src/lib/export.ts:645`、`ExportDialog.tsx:122`） | ✅ |

### 検証項目

- [ ] **🟡 OGP の SSRF 防御**: プライベート IP / loopback / link-local を弾くか（`electron/main/ipc/ogp.ts` の hostname / IP チェック）
- [x] **✅ OGP DNS rebinding 強化**: `pinSafeLookup` で hostname を 1 度だけ resolve → `isGlobalIp` で validate → 解決済み IP を pin して http(s).request の `lookup` フックに渡す（`electron/main/utils/ssrf-guard.ts` の `pinSafeLookup`）。validation 後に攻撃者の DNS が応答を切替えても connect 時に再問い合わせが発生しないので影響しない。redirect も 1 hop ごとに再 pin（closes #29、`ssrf-guard.test.ts` の "DNS rebinding defense" describe 群で網羅）
- [ ] **🟡 PDF の絵文字 / 日本語フォント**: 旧版と同等に表示されるか（packaged build の `--font` オプションは Electron では効かないため、CSS 側の font-family 指定で吸収する設計）
- [ ] **🟡 HTML エクスポートの保存先選択**: `dialog:save` 経由で workspace 外（例: `~/Desktop/`）に保存できるか
- [ ] **🟡 Prompt エクスポート**: `~/Downloads/<title>-prompt.md` 等として保存できるか。custom template の有無で出力差分（`buildPromptFromTemplate` vs `buildPrompt`）が出るか
- [ ] **🟡 transient write capability の境界**:
  - SaveDialog で workspace 外パスを選択 → 直後の書き込みは成功すること
  - 書き込み完了後、同じ window から **同じパスへの 2 回目の書き込みは拒否される** こと（consume-on-write 動作）
  - SaveDialog を開いた window を閉じた後、別 window から同じパスに書き込もうとして拒否されること（cleanup-on-close 動作）
- [ ] **🟡 `shell.openExternal` のスキーム検証**: 旧版は `https://` `http://` のみ許可していた。新 `electron/main/ipc/shell.ts` も同等か

---

## 6. アップデートチェック / アプリ情報

| 旧コマンド | 新ハンドラ | 状態 |
|---|---|---|
| `check_for_update` | `update:check` | ✅（GitHub Releases API ポーリング） |
| `getVersion` (`@tauri-apps/api/app`) | `getAppVersion` | ✅ |
| `clear_webview_browsing_data` | `window:clear-webview-data` | ✅ |
| `getCurrentWindow().close()` | `closeWindow` | ✅ |

### 既知差分

- ⚠️ **`update.ts:GITHUB_API_URL`** は現在 `ymnao/scripta-next` を指している。リポジトリリネーム時に `ymnao/scripta` へ戻す必要あり（コメント記載済み、`docs/migration-plan.md` Stage 6 リリース切り替え項目で対応）。

### 運用方針

- **update 存在確認のみで運用、auto-download / auto-install は scope 外**（旧 Tauri 版もそうだった）。GitHub Releases API ポーリングで latest tag を取得し、新しいバージョンがあれば UI 上で通知してユーザーに手動アップデートを促す形を維持する。
- `electron-updater` は導入しない。導入すると：(a) コードサイニング必須、(b) `release.yml` の secret 注入、(c) `electron-builder.yml: mac.target: zip` 等の付帯対応、(d) 配信チャンネル設計、までが芋づるで必要になる。本プロジェクトはコードサイニングを採用しない方針（§ 11 / § 12 参照）なので一貫して「存在確認のみ」とする。

---

## 7. 設定永続化（旧 plugin-store → 新 settings IPC）

| 旧 | 新 | 状態 |
|---|---|---|
| `Store.load("settings.json")` | `settings:get` / `settings:set` / `settings:delete` / `settings:save` | ✅ |
| 旧キー: `workspacePath`, `sidebarVisible`, など | 同名キーで保持。`workspacePath` のみ main 側 reserved | ✅ |
| 永続先 | `app.getPath("userData") + "/settings.json"` | ✅ |

### 検証項目

- [ ] **🟡 旧 Tauri 版 userData との互換**: `~/Library/Application Support/scripta/settings.json` を旧 Tauri 版が書いた状態で新 Electron 版を起動 → 既存設定（特に `workspacePath`）を正しく読めるか
  - HANDOFF.md / index.ts:21 で `app.isPackaged` 時のみ `app.setName("scripta")` をかける gating が入っているので **packaged build** で要検証
  - dev 起動時は `~/Library/Application Support/scripta-next/` 名前空間に隔離される（dev 作業が本番設定を汚染しない設計）

---

## 8. メニュー / ウィンドウ状態（Stage 6-1）

| 旧（Tauri `setup_menu`） | 新（Electron `Menu.setApplicationMenu`） | 状態 |
|---|---|---|
| App: About / Settings... / Hide / Quit | 同等 | ✅ |
| File: New Window / エクスポート... | 同等 | ✅ |
| Edit: Undo / Redo / Cut / Copy / Paste / Select All | 同等 | ✅ |
| （旧版なし） | View: Reload / Toggle DevTools / Zoom | ✅（新規追加。Chromium 標準動作の補完目的、`menu.ts` コメント参照） |
| （旧版なし） | Window: Minimize / Zoom / Close | ✅（新規追加。macOS 標準ウィンドウ操作の保全） |
| Help: Keyboard Shortcuts | 同等 | ✅ |
| menu イベントの renderer 配信 | `menu:open-settings` / `menu:open-help` / `menu:export` を focused window のみへ送信 | ✅ |

### ウィンドウ状態永続化（Stage 6-1 新規）

- 位置 / サイズ / 最大化状態を `settings.json` の `windowState` キーへ保存（旧 Tauri 版にもあったが Tauri plugin-window-state ベース）。
- 検証項目:
  - [ ] **🟡 新規ウィンドウ（"New Window" メニュー / Cmd+Shift+N）はデフォルト位置で開く**こと（旧版と同じく `?newWindow=true` で workspace 復元抑止）

---

## 9. ファイル URL / 画像レンダリング 🟡

### 旧版との対応（保険実装で対応済 — issue #22, PR feat/scripta-asset-protocol）

| 旧 Tauri | 新 Electron |
|---|---|
| `convertFileSrc(path)` → `asset://localhost/<path>` | `convertFileSrc(path)` → `scripta-asset://localhost/<encoded path>`（per-segment `encodeURIComponent` + Windows `\` → `/` 正規化 + leading `/` 付与で `new URL()` パース可能を保証） |
| CSP `img-src 'self' asset: https://asset.localhost https:` | CSP `img-src 'self' https: data: blob: scripta-asset:` |
| Tauri が `asset:` プロトコルハンドラを内蔵 | `scripta-asset://` をカスタムプロトコルとして main 側で登録（`protocol.handle` + `net.fetch`） |

### 実装

- `electron/main/index.ts`:
  - `protocol.registerSchemesAsPrivileged([{ scheme: "scripta-asset", privileges: { standard, secure, supportFetchAPI, stream } }])` を `app.whenReady` 前に呼ぶ
  - `app.whenReady` 内で `protocol.handle("scripta-asset", handler)` を登録
  - ハンドラは hostname=`localhost` を要求し、`urlPathnameToFsPath(url.pathname)` で OS path に戻してから（Windows 上のみ drive letter 形式の leading `/` を除去、POSIX では `/C:/...` も合法絶対パスとして保持）path-guard の process-wide チェック（`isPathWithinAnyAllowedRoot`）を通過した path のみ `net.fetch(pathToFileURL(path))` で配信
  - 失敗時はステータスのみ返し本文に path を含めない（情報漏洩防止）
- `electron/preload/scripta-asset-url.ts`: `buildScriptaAssetUrl` / `urlPathnameToFsPath` を切り出し（preload・main・テスト mock すべての canonical な実装。drift 防止）
- `electron/preload/index.ts`: `convertFileSrc: (path) => buildScriptaAssetUrl(path)`
- `electron/main/utils/path-guard.ts`: `isPathWithinAnyAllowedRoot(p)` を追加（全 window の登録 root を union で見る。リクエスト元 webContents を特定できないプロトコルハンドラ専用）

### 信頼境界

- ファイル配信は「いずれかの window が register 済みの workspace 配下」のみに限定（fail-closed）
- macOS の `/var → /private/var` 等の symlink 経由 escape は `realpath` 正規化で塞がれる
- CSP `img-src` には `file:` を許可しないため、任意 file 読み取りには昇格しない

### 検証項目

- [ ] **🟡 packaged build でローカル画像 `![](/path/to/img.png)` がレンダリングされるか実機確認**（issue #26 のスモークと兼用）
- [ ] **🟡 ワークスペース外 path 指定時に 403 で拒否されることを確認**（DevTools → Network で response status を確認）
- [ ] **🟡 DevTools Console に CSP 違反エラーが出ないこと**

### 既知の制約

- 本リポジトリは macOS が一次ターゲットだが、`buildScriptaAssetUrl` は backslash 正規化と drive letter 形式に対応しているため Windows でも URL レベルでは valid。ただし packaged build での実機検証は未実施（issue #26 の手動スモーク内で対応）

---

## 10. e2e テストカバレッジ

| 旧 e2e（Tauri、`/Users/nakiym/development/tools/scripta/e2e/*.spec.ts`） | 新 e2e（Electron、`e2e/*.spec.ts`） | 状態 |
|---|---|---|
| 23 spec（slide-view, file-watcher, settings-persistence, ...） | 同 23 spec + `smoke.spec.ts`（Stage 6-2 新規） | ✅ |
| 旧 `playwright-tauri` 経由で実 Tauri バイナリ起動 | renderer-only モード: Vite dev server + `addInitScript` で `window.api` モック注入 | ⚠️ |

### 既知差分

- ⚠️ **renderer-only モードの限界**: 新 e2e は実 Electron / 実 main プロセスを起動しない。実 IPC エンドツーエンドは Vitest unit test でカバーする設計（`electron/main/ipc/*.test.ts` 群）。
  - メリット: 並列性・速度・CI コスト
  - デメリット: 実 IPC payload のシリアライズ / contextBridge / preload の実装ミスは検出できない。`smoke.spec.ts` も renderer-only 起動

### 検証項目

- [ ] **🟡 packaged build に対する手動スモーク**: `pnpm dist` 後、生成された .dmg / .AppImage / .exe を起動して以下を確認:
  - [ ] Sidebar の "フォルダを開く" ボタン → OS ダイアログ → ワークスペース復元（§ 2 dialog:open-directory 経路の信頼境界確認）
  - [ ] `.md` を読み書きできる
  - [ ] ファイル監視が反映される
  - [ ] 全文検索（Cmd+Shift+F）が動く
  - [ ] Git status / commit / pull / push が動く（§ 4 必須 #3 と兼用）
  - [ ] エクスポート全 3 形式が出力される（**PDF / HTML / Prompt(.md)**）。HTML / Prompt は workspace 外パス（例: `~/Desktop/`）への保存ダイアログ経由で、§ 5 transient write capability が機能することを確認
  - [ ] OGP リンクカードが表示される
  - [ ] アップデートチェックが API を叩く（`update.ts` の URL は現状 `scripta-next` を指す）
  - [ ] ウィンドウ位置 / サイズが次回起動時に復元される
- [ ] （任意）Stage 6 完了の品質ゲートとして、最低 1 本の Playwright `_electron` API ベース e2e を追加するかは別判断。renderer-only で十分か実 Electron も必要かは出荷後の不具合状況で判断する余地あり（migration-plan の Stage 6 では明示的にどちらかを要求していない）

---

## 11. 配布

### Stage 6-4 完了済（PR #19, #20）

- ✅ `electron-builder.yml`（appId/productName/icon/各 OS target）
- ✅ `.github/workflows/release.yml`（tag push → matrix dist → draft Release）
- ✅ `package.json:version` と tag の事前一致 verify
- ✅ AUMID `com.scripta.app` / `app.setName("scripta")`（packaged のみ）

### 運用方針

- **未署名で出荷**（旧 Tauri 版同等の方針）。コードサイニング / 公証は採用しない。macOS Gatekeeper / Windows SmartScreen の警告は受容し、README とリリースノートで起動手順を案内する。
- `update.ts:GITHUB_API_URL` の `scripta-next` → `scripta` への切り替えはリポジトリリネーム時に行う（コード内コメントが canonical）。

---

## 12. リリース前ブロッカー早見表

v0.2.0 リリース（旧 `ymnao/scripta` との機能パリティ確認）の最終 GO/NO-GO チェックリスト。

> コードサイニングと electron-updater 配線は **採用せず**（§ 6 / § 11 参照）。未署名で出荷する旧 Tauri 版と同等の方針。Gatekeeper / SmartScreen 警告は受容する。

### 必須（GO 条件）

優先順位は「取り返しのつかなさ」と「ユーザー影響範囲」の積で決定。

1. [ ] § 9 の **ローカル画像レンダリング** が packaged build で動く（保険実装 `scripta-asset://` は merged 済み — issue #22。要実機検証）
   — メモアプリの中核機能、`scripta-asset://` プロトコル経由でレンダリングされること / DevTools で CSP 違反が出ないこと / ワークスペース外 path が 403 で拒否されることを確認
2. [ ] § 7 の **旧 userData 互換**（`~/Library/Application Support/scripta/settings.json` の継承）が確認済み
   — 既存ユーザーの workspace / window state を保全。落ちると **設定消失（取り返しのつかない regression）**
3. [ ] § 4 の **Git remote 認証実機確認**（HTTPS credential helper / SSH agent で commit + pull + push が一往復成功）
   — Git Sync は新版の中核機能、認証経路は packaged build でしか検証不能
4. [ ] § 10 の **packaged build 手動スモーク** が一通り pass

### 推奨（NICE-TO-HAVE）

- [x] § 5 の OGP DNS rebinding 強化（PR #39 で対応済、closes #29）
- [ ] § 10 の Playwright `_electron` API ベース最小 e2e 追加（少なくとも 1 本: workspace 選択 → md open → write → 再起動して内容残存）

### リリース後の継続課題（v0.2.0 blocker ではない）

v1.0.0 milestone として GitHub issue 化済。リリース後の継続改善とする。

- [ ] [#31](https://github.com/ymnao/scripta-next/issues/31) refactor: `realpath` の async 化（path-guard 全体波及）
- [ ] [#32](https://github.com/ymnao/scripta-next/issues/32) refactor: approve リストを window-scoped に変更
- [ ] [#33](https://github.com/ymnao/scripta-next/issues/33) test: Playwright `_electron` API ベースの最小 e2e を追加

---

## 13. v1.0.0 昇格 checklist

v1.0.0 は「完璧の象徴」として温存する方針。初期リリースは v0.2.0 とし、以下 6 項目すべてが pass した時点で v1.0.0 へ昇格する。

1. [ ] **§ 12「リリース後の継続課題」3 項目（issue #31 / #32 / #33）がすべて closed**
   — リリース後の継続改善が一通り片付いた状態。
2. [ ] **§ 12 必須 + 推奨 すべて close**
   — § 12 必須 4 項目（ローカル画像 / userData 互換 / Git 認証 / packaged build スモーク）と推奨 2 項目（OGP DNS rebinding ✅ / Playwright `_electron` 最小 e2e）の全クローズ。
3. [ ] **`scripta-asset://` プロトコルが macOS / Windows packaged build 双方で実機検証済み + 推奨項目の Playwright `_electron` e2e でガード済み**
   — § 9 ローカル画像の「保険実装」段階を脱して回帰検出に組み込まれた状態。issue #26 のスモークが 1 度走っただけでなく、項目 5 の e2e で継続検出される構成になっていること。
4. [ ] **v0.2.0 リリースから 14 日以上経過 / データ消失・起動不能・主要機能停止クラスの hotfix リリース 0 件**
   — 出荷後の stability period（14 日）。Hotfix リリース（v0.2.x）が出た場合は v0.2.0 ではなく hotfix リリース日から再起算する。
5. [ ] **Playwright `_electron` API ベース最小 e2e 1 本以上**
   — § 10 の renderer-only モード単独では実 IPC payload のシリアライズ / contextBridge / preload 実装ミスを検出できない。最低 1 本の実 Electron 起動 e2e で「workspace 選択 → md open → write → 再起動して内容残存」を覆う。
6. [ ] **Dependabot 残債ゼロ**
   — open な Dependabot PR が 0 件。security advisory（pnpm audit / GitHub security tab）も clean。

### 昇格時の作業

- `package.json:version` を `1.0.0` に bump
- `CHANGELOG.md` に v1.0.0 セクション（v0.2.0 → v1.0.0 の累積差分要約）
- tag push → `release.yml` で配布バイナリ生成
- README とリリースノートで v1.0.0 昇格条件 6 項目の達成を明記

---

## 14. 更新履歴

- 2026-05-08: 初版作成（Stage 6-4 完了直後、`9f32815` / `dcbc68b` を取り込んだ状態で audit）。
- 2026-05-09: v0.2.0 リリース方針確定（issue #24）。コードサイニング / electron-updater 採用せず方針を § 6 / § 11 / § 12 に反映。§ 13 v1.0.0 昇格 checklist 6 項目を追加。
