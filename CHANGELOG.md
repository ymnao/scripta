# Changelog

すべての注目すべき変更はこのファイルに記録する。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/spec/v2.0.0.html) に従う。

## [0.3.0] — 2026-06-13

v0.2.0 の Electron 移行直後リリース。テーブル UX とエクスポート品質の改善、KaTeX の完全オフライン化、v0.2.0 で「既知の制限」として挙げていた approve リスト / realpath の構造課題の解消が主軸。

### Added

- **テーブル UX**: セルをまたぐ範囲選択 + TSV コピー/ペースト (#119 → #148)、表外への TSV ペーストで Markdown テーブルを自動生成 (#159)
- **アイコンボタンの tooltip**: 機能名 + ショートカットキーをカスタム tooltip で表示。`disabled` 属性ではなく `aria-disabled` + onClick ガードで「無効時も hover で説明が出る」設計 (#161 → #178)
- **KaTeX オフライン化**: CSS / フォントを完全にローカル同梱、外部 CDN への fetch なし (#145)

### Changed

- **approve リストの window-scoped 化**: プロセス全体スコープから per-window スコープへ。同一プロセス内の別ウィンドウから approve が漏れない設計に (#32 → #150, #151)
- **path-guard の realpath を async 化**: 同期版 `realpathSync` から `fs.promises.realpath` へ。メインプロセスのイベントループを塞がない (#31 → #149)
- **UI 全体のブラッシュアップ**: タブバー / アイコン / 余白の整理 (#162)

### Fixed

- **エディタ**: テーブル境界の巨大キャレットを修正、テーブル外への移動に gap cursor を導入 (#146, #167 → #168)
- **エディタ**: リスト / タスクリストのマーカー隙間クリックで構文が破壊されるバグを修正 (#164)
- **エディタ**: 複数行選択時にハイライトがエディタ左右 padding 領域にはみ出すバグを修正 (#166)
- **エディタ**: 未セーブインジケータでタブ幅が変動するバグを修正 (#165)
- **エディタ**: タスクリストの Tab ネスト幅を bullet と揃えて 2 スペースに統一 (#179)
- **ファイル I/O**: オートセーブが停止しうる 2 経路を防御的に塞ぐ (#163)
- **PDF エクスポート**: エディタ上で display math 扱いになる寛容パターンを export にも適用 (#169 → #170)
- **e2e**: Vite dev server の bind 先を `127.0.0.1` に明示して `::1` の listen EPERM を解消 (#171 → #173)
- **テスト**: watcher integration テストで `registerWorkspaceRoot` の await 漏れを修正 (#172 → #174)

### Security

- **KaTeX オフライン化に伴う `tmp` 脆弱性解消**: 中間生成物の取り扱いを見直し、`tmp` 経由の脆弱性を遮断 (#145)
- **path-guard async 化**: realpath の正規化を async 経路へ移行し、symlink 解決中のレース窓を縮小 (#149)

### Internal

- **テストフィクスチャ集約**: `electron/main/test-utils/temp-workspace.ts` に `createTempWorkspace` / `createCanonicalTempWorkspace` / `createSymlinkedWorkspace` / `makeCanonicalTempDir` を集約、10 ファイルを移行 (#184)
- **watcher テスト構造整理**: `watcher.integration.test.ts` を start/stop race と symlinked workspace の 2 describe に分離 (#175 → #183)
- **platform 判定統一**: 残存していたローカル `process.platform === "darwin"` 等を `platform.ts` に集約 (#177 → #182)
- **Biome `noFloatingPromises` 有効化**: floating promise 違反 10 件を解消 (#176)

### Dependencies

v0.2.0 → v0.3.0 で更新された主要パッケージ:

- react / react-dom 19.2.6 → 19.2.7
- @codemirror/autocomplete 6.20.2 → 6.20.3
- marked 18.0.4 → 18.0.5
- vite 8.0.14 → 8.0.16
- vitest 4.1.7 → 4.1.8
- @biomejs/biome 2.4.15 → 2.4.16

electron / mermaid / zustand / tailwindcss / dompurify 等の主要版は v0.2.0 と同等。Dependabot 7 件 (#152–#158 → #160) を一括取り込み。

### v0.2.0 の「既知の制限」進捗

- **approve リストはプロセス全体スコープ (#32)** → ✅ 解消（v0.3.0）
- **`realpath` は同期版 (#31)** → ✅ 解消（v0.3.0）
- パッケージは未署名 → 据え置き（v1.0.0 で対処予定）
- e2e テストは renderer-only モード → ✅ 解消（実 Electron e2e job を CI に追加、ローカルでも `pnpm test:e2e:electron` で実行可能）

## [0.2.0] — 2026-06-05

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

[0.3.0]: https://github.com/ymnao/scripta/releases/tag/v0.3.0
[0.2.0]: https://github.com/ymnao/scripta/releases/tag/v0.2.0
