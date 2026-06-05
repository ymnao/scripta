# Changelog

すべての注目すべき変更はこのファイルに記録する。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/spec/v2.0.0.html) に従う。

## [0.2.0] — _(unreleased)_

旧 Tauri 版 `ymnao/scripta-tauri`（現在は private）の **Electron への完全書き直し版**。Electron + React 19 + CodeMirror 6 + zustand v5 + Tailwind CSS v4 + Vite 8 + Biome を採用し、旧版とのパリティ + 新機能を提供する。

旧 Tauri 版の userData (`~/Library/Application Support/scripta/settings.json`) との互換を保持しているため、旧版から移行しても workspace / window state は引き継がれる（packaged build 限定。dev は `scripta-next` 名前空間に隔離）。

### Added

#### コア機能（旧 Tauri 版とパリティ）

- ファイル I/O（read / write / create / rename / delete / path-exists / list-directory）。ワークスペース外への read/write は main 側 `path-guard` で拒否 (#6)
- `chokidar` ベースのファイル変更監視 (#12)
- 純 JS による全文検索 / ファイル名検索 / 未解決 wikilink スキャン（旧 Rust ロジックを 1:1 移植）(#13)
- `simple-git` ベースの Git Sync（status / commit / pull / push / コンフリクト解決ウィンドウ）(#14)
- OGP リンクカード（自前 HTTP fetch + 自前 OGP パーサ + SSRF 防御） / PDF / HTML / Prompt(.md) エクスポート / `shell.openExternal` の scheme allowlist (#15)
- GitHub Releases API ポーリングによるアップデートチェック（auto-download / auto-install は scope 外）(#15)
- 設定永続化（`app.getPath("userData") + "/settings.json"`）(#15)
- アプリケーションメニュー / ウィンドウ状態永続化 (#16)

#### 新機能（旧版にない）

- `search:cancel` IPC（in-flight 検索をキャンセル可能）(#13)
- `scanUnresolvedWikilinks` の cancellation 対応 (#30, #36)
- ローカル画像レンダリング用カスタムプロトコル `scripta-asset://`。`protocol.handle` + `net.fetch` 実装、CSP `img-src` に追加 (#22, #35)
- View / Window メニュー（Reload / Toggle DevTools / Zoom / Minimize / Close）。Chromium 標準動作の補完目的 (#16)
- ファイルツリーで隠しファイル / 除外パターンの表示制御 (#45)
- Settings に「今すぐアップデートを確認」ボタンを追加（手動でのアップデートチェック）(#98 → #138)
- OGP fetch の DNS rebinding 防御強化: `pinSafeLookup` で hostname を 1 度だけ resolve → `isGlobalIp` で validate → 解決済み IP を pin (#29)
- `dialog:save` 経由の `registerTransientWritePath`: workspace 外への保存を window-scoped な短命 write capability で許可（書き込み成功で consume、window close で cleanup）

#### インフラ

- `electron-builder.yml` + `.github/workflows/release.yml`（tag push → matrix dist → draft Release）(#19, #20)
- Vitest ユニットテスト + Playwright e2e（renderer-only モード、`window.api` モック注入）(#17, #18)
- CI ワークフロー（lint / typecheck / test / build）(#3)

### Changed

- アーキテクチャ: Tauri v2 (Rust) → Electron + React 19 + zustand v5 + CodeMirror 6 + Tailwind CSS v4 + Vite 8
- IPC: `@tauri-apps/api/core` の `invoke` → `contextBridge` で公開する `window.api`
- パッケージマネージャ: pnpm 11.1.1 へ更新、設定を `pnpm-workspace.yaml` に集約（pnpm 11 既定値の `minimumReleaseAge` / `blockExoticSubdeps` / `strictDepBuilds` を明示宣言）(#57)
- リンタ / フォーマッタ: ESLint + Prettier → Biome 2.4.15
- アプリ名: packaged build のみ `app.setName("scripta")`（旧 Tauri 版 userData との互換維持）

### Fixed

- electron 42 対応: postinstall script 削除へのバイナリ取得補完 + `electron` module の external 化 (#37)
- タイトルバー / タブバー UX 改善 (#41, #43)
- 罫線 (`---`) のカーソル行で raw 表示に戻す (#42, #44)
- `git.test.ts` の flaky なネットワークエラーテストを安定化 (#59)
- テーブル系: セル内 paste / 境界カーソル / Cmd+Z / focusout の挙動を修正 (#88, #89, #90 → #116, #120)
- リスト・見出し系: 番号付きリストの inline 改行 / Heading 装飾を修正 (#91, #92 → #117)
- PDF export: Mermaid 改ページ / ハイライト改ページ / 番号付きリスト inline を修正 (#79, #93, #106 → #124, #130, #131)
- フォント: monospace stack を Tailwind `--font-mono` に統合 (#97 → #132)
- ファイル I/O: 末尾改行の正規化を renderer 側 `processContent` で安定化 (#100 → #134)
- リンク UX: URL paste と md リンク / OGP カードの挙動を改善 (#96 → #135)
- リスト Tab / Shift+Tab: list-aware なインデント + 再採番 (#118 → #136)
- OGP fetch: AbortController で cancel 可能化 (#101 → #137)

### Dependencies

主要バージョン（v0.2.0 リリース時点）:

- electron 42.3.3
- react / react-dom 19.2.6
- @codemirror/view 6.43.0 / @codemirror/autocomplete 6.20.2
- zustand 5.0.14
- mermaid 11.15.0
- marked 18.0.4
- dompurify 3.4.8
- js-yaml 4.2.0
- lucide-react 1.17.0
- tailwindcss 4.3.0 / @tailwindcss/vite 4.3.0
- vite 8.0.14
- vitest 4.1.7
- @playwright/test 1.60.0
- @biomejs/biome 2.4.16
- write-file-atomic 8.0.0

### Security

- `scripta-asset://`: hostname=`localhost` 強制 + path-guard 通過必須 + 失敗時にレスポンス本文に path を含めない（情報漏洩防止）
- OGP fetch: プライベート IP / loopback / link-local を `pinSafeLookup` で弾き、redirect も 1 hop ごとに再 pin
- `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` を維持

### 既知の制限（v1.0.0 で対処予定）

- パッケージは未署名（macOS Gatekeeper / Windows SmartScreen の警告は受容）
- e2e テストは renderer-only モード（実 Electron 起動 e2e は #33 で対応予定）
- approve リストはプロセス全体スコープ（#32 で window-scoped 化予定）
- `realpath` は同期版（#31 で async 化予定）

[0.2.0]: https://github.com/ymnao/scripta/releases/tag/v0.2.0
