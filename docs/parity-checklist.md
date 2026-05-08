# 機能パリティ確認チェックリスト（Tauri → Electron）

> Stage 6 完了判定の一部。本リポジトリ（Electron 版）が旧 `ymnao/scripta`（Tauri 版、`/Users/nakiym/development/tools/scripta`）と同等以上であることを、リリース切り替え前に検証する。
>
> 各項目には **状態ラベル**（✅ 移植済 / 🟡 要実機検証 / ⚠️ 既知差分 / ⛔ 未実装 / 🔁 別段 follow-up）と参照ファイルパスを記載する。

## 0. 凡例

- **✅ 移植済**: 実装が存在し、Vitest / Playwright（renderer-only）でカバー済み
- **🟡 要実機検証**: 実装は存在するが、`pnpm dist` パッケージビルドで動作確認が必要（renderer-only e2e ではカバーできない領域）
- **⚠️ 既知差分**: 旧版と挙動が異なることが判明している。要判断（許容 / 修正）
- **⛔ 未実装**: 旧版に存在するが新版未着手。リリース blocker 候補
- **🔁 別段 follow-up**: Stage 6 残項目として既に把握済（コードサイニング / electron-updater 配線 等）

参照基準:

- 旧 Tauri 版コマンド一覧: `/Users/nakiym/development/tools/scripta/src-tauri/src/lib.rs` の `invoke_handler!` ブロック（30 コマンド）
- 旧フロント側プラグイン使用: `@tauri-apps/api/{core,event,window,webviewWindow,app}` / `@tauri-apps/plugin-{shell,dialog,store}`
- 新 Electron API 表面: `electron/preload/api.ts` の `Api` 型 + `electron/preload/index.ts` の `contextBridge.exposeInMainWorld`
- 新フロント呼び出し: `src/lib/commands.ts`

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

| 旧コマンド | 新ハンドラ | 状態 | 備考 |
|---|---|---|---|
| `list_directory`（再掲） | `fs:list` | ✅ | |
| `start_watcher` | `watcher:start` | ✅ | `chokidar` ベース、`electron/main/ipc/watcher.ts` |
| `stop_watcher` | `watcher:stop` | ✅ | |
| イベント `fs-change` (Tauri `listen`) | `onFsChange` | ✅ | `webContents.send` ベース |

### 新版でのみ存在

- `workspace:set` IPC（旧版は frontend 側 `loadSettings/saveWorkspacePath` で完結）
  - 役割: main 側に "approve list" を構築し、path-guard の判定基盤として機能。
  - 設計判断: 旧版は path-guard 自体が Rust 側 fs プラグインの permission 経由で行われていたが、新版はメインプロセスの自前 path-guard 実装に置換。

### 検証項目

- [ ] **🟡 chokidar の large workspace 挙動**: 数千ファイル規模のワークスペースで watcher が安定して動くか（FSEvents / inotify の上限到達時のフォールバック確認）
- [ ] **🟡 fs-change イベント coalescing**: 連続書き込み時に旧版と同等の頻度で renderer に届くか（過剰イベントで UI が固まらないか）

---

## 3. 全文検索（Stage 3）

| 旧コマンド | 新ハンドラ | 状態 | 備考 |
|---|---|---|---|
| `search_files` | `search:files` | ✅ | 純 JS で旧 Rust ロジックを 1:1 移植（`electron/main/ipc/search.ts`） |
| `search_filenames` | `search:filenames` | ✅ | |
| `scan_unresolved_wikilinks` | （`search:scan-unresolved-wikilinks` 等） | ✅ | |
| なし | `search:cancel` | ✨ 新規 | 旧版にない cancellation API。`SearchPanel` の useEffect cleanup から呼ばれる |

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

## 5. OGP / PDF / 外部リンク（Stage 5）

| 旧コマンド | 新ハンドラ | 状態 |
|---|---|---|
| `fetch_ogp` | `ogp:fetch` | ✅ `undici` + `cheerio`、SSRF 防御 |
| `export_pdf` | `pdf:export` | ✅ 隠し BrowserWindow + `webContents.printToPDF` |
| `open` (`@tauri-apps/plugin-shell`) | `shell:open-external` | ✅ scheme allowlist |

### 検証項目

- [ ] **🟡 OGP の SSRF 防御**: プライベート IP / loopback / link-local を弾くか（`electron/main/ipc/ogp.ts` の hostname / IP チェック）
- [ ] **🟡 OGP DNS rebinding 強化**: HANDOFF.md の "将来課題" に挙がっている item。ホスト名解決後 → connect 時の二重チェックが追加されたかは未確認
- [ ] **🟡 PDF の絵文字 / 日本語フォント**: 旧版と同等に表示されるか（packaged build の `--font` オプションは Electron では効かないため、CSS 側の font-family 指定で吸収する設計）
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

- ⚠️ **`update.ts:GITHUB_API_URL`** は現在 `ymnao/scripta-next` を指している。リリース切り替え時に `ymnao/scripta` へ戻す必要あり（コメント記載済み、`docs/migration-plan.md` Stage 6 リリース切り替え項目で対応）。

### 🔁 別段 follow-up（Stage 6 残項目）

- 🔁 **electron-updater 配線**: 現在は GitHub API ポーリングのみで、自動ダウンロード / インストールは未実装。`pnpm install electron-updater` 後に `update.ts` を `autoUpdater` イベント配線へ置換する。`release.yml` の `# keep in sync` glob と `electron-builder.yml: mac.target: zip` を併せて更新（PR #20 の TODO 参照）。

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
| View: Reload / Toggle DevTools / Zoom | 同等 | ✅ |
| Window: Minimize / Zoom / Close | 同等 | ✅ |
| Help: Keyboard Shortcuts | 同等 | ✅ |
| menu イベントの renderer 配信 | `menu:open-settings` / `menu:open-help` / `menu:export` を focused window のみへ送信 | ✅ |

### ウィンドウ状態永続化（Stage 6-1 新規）

- 位置 / サイズ / 最大化状態を `settings.json` の `windowState` キーへ保存（旧 Tauri 版にもあったが Tauri plugin-window-state ベース）。
- 検証項目:
  - [ ] **🟡 新規ウィンドウ（"New Window" メニュー / Cmd+Shift+N）はデフォルト位置で開く**こと（旧版と同じく `?newWindow=true` で workspace 復元抑止）

---

## 9. ファイル URL / 画像レンダリング ⚠️

### 既知差分（要実機検証）

| 旧 Tauri | 新 Electron |
|---|---|
| `convertFileSrc(path)` → `asset://localhost/<path>` | `convertFileSrc(path)` → `path`（そのまま返す） |
| CSP `img-src 'self' asset: https://asset.localhost https:` | CSP `img-src 'self' https: data: blob:` |
| Tauri が `asset:` プロトコルハンドラを内蔵 | カスタムプロトコル登録なし |

### 懸念

- 新 CSP には `file:` が含まれない。`<img src="/Users/foo/img.png">` は `file:///Users/foo/img.png` として解決される可能性が高く、CSP `img-src 'self'` での `file:` 取り扱い次第ではブロックされる。
- `images.test.ts` は `convertFileSrc` を `asset://localhost...` でモックしているため、テストは通るが実機挙動を保証しない。

### 検証項目

- [ ] **🟡 packaged build でローカル画像 `![](/path/to/img.png)` がレンダリングされるか実機確認**
  - 失敗時の対応案:
    1. CSP `img-src` に `file:` を追加（簡単だが任意 file 読み取りを許可してしまう）
    2. カスタムプロトコル `scripta-asset://` を main 側で `protocol.registerFileProtocol` 登録（Tauri と同等の安全性、`convertFileSrc` の戻り値をそれに合わせる）
    3. main 側で読み出して `data:` URL を返す（`convertFileSrc` を async 化）
  - 推奨は 2（Tauri の挙動を 1:1 で再現でき、CSP も狭く保てる）

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
  - [ ] ワークスペースを開ける
  - [ ] `.md` を読み書きできる
  - [ ] ファイル監視が反映される
  - [ ] 全文検索（Cmd+Shift+F）が動く
  - [ ] Git status / commit / pull / push が動く
  - [ ] エクスポート（PDF / HTML）が出力される
  - [ ] OGP リンクカードが表示される
  - [ ] アップデートチェックが API を叩く（`update.ts` の URL は現状 `scripta-next` を指す）
  - [ ] ウィンドウ位置 / サイズが次回起動時に復元される
- [ ] （任意）Stage 6 完了の品質ゲートとして、最低 1 本の Playwright `_electron` API ベース e2e を追加するかは別判断。renderer-only で十分か実 Electron も必要かは出荷後の不具合状況で判断する余地あり（migration-plan の Stage 6 では明示的にどちらかを要求していない）

---

## 11. 配布 / コードサイニング 🔁

### Stage 6-4 完了済（PR #19, #20）

- ✅ `electron-builder.yml`（appId/productName/icon/各 OS target）
- ✅ `.github/workflows/release.yml`（tag push → matrix dist → draft Release）
- ✅ `package.json:version` と tag の事前一致 verify
- ✅ AUMID `com.scripta.app` / `app.setName("scripta")`（packaged のみ）

### 🔁 別段 follow-up（Stage 6 残項目）

- 🔁 **コードサイニング / 公証**:
  - macOS notarization: Apple Developer 証明書 / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 手配（ユーザー作業）。`electron-builder.yml: mac.notarize` 設定 + `release.yml` から `CSC_IDENTITY_AUTO_DISCOVERY=false` 解除 + `CSC_LINK` / `CSC_KEY_PASSWORD` secret 注入
  - Windows EV 証明書: `electron-builder.yml: win.signtoolOptions` 設定
- 🔁 **electron-updater 配線**（再掲、第 6 節参照）
- 🔁 **リリース切り替え**:
  - `ymnao/scripta` を `ymnao/scripta-tauri` 等にリネーム → 本リポジトリを `ymnao/scripta` として公開
  - `electron/main/ipc/update.ts:GITHUB_API_URL` を `scripta-next` → `scripta` に戻す（コード内コメントで明示済み）
  - `electron-builder.yml: publish` / `release.yml: gh release create/upload` は git remote 自動推定なので修正不要

---

## 12. リリース前ブロッカー早見表

リリース切り替え（旧 `ymnao/scripta` → 本リポジトリ）の最終 GO/NO-GO チェックリスト。

### 必須（GO 条件）

1. [ ] § 9 の **ローカル画像レンダリング** が packaged build で動く（または対処済み）
2. [ ] § 10 の **packaged build 手動スモーク** が一通り pass
3. [ ] § 11 の **コードサイニング / 公証** がパイプラインに組み込まれ、未署名警告が出ない
4. [ ] § 7 の **旧 userData 互換**（`~/Library/Application Support/scripta/settings.json` の継承）が確認済み
5. [ ] § 6 の **electron-updater 配線** + `update.ts:GITHUB_API_URL` のリポジトリ名切り替え

### 推奨（NICE-TO-HAVE）

- [ ] § 4 の Git remote 認証実機確認（HTTPS credential helper / SSH agent）
- [ ] § 5 の OGP DNS rebinding 強化（HANDOFF.md の "将来課題" 由来）
- [ ] § 10 の Playwright `_electron` API ベース最小 e2e 追加

### Stage 5 から継続課題（リリース blocker ではない）

`HANDOFF.md` の "Stage 5 から継続の課題" セクションに集約済:

- realpath の async 化（Stage 1 から）
- `scanUnresolvedWikilinks` の cancellation 対応（Stage 3 から）
- approve リストの window-scoped 化（Stage 4 から、現状 global）
- OGP fetch の hostname-based DNS rebinding 強化

これらはリリース後の継続改善とする方針。

---

## 13. 更新履歴

- 2026-05-08: 初版作成（Stage 6-4 完了直後、`9f32815` / `dcbc68b` を取り込んだ状態で audit）。
