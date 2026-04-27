# Tauri → Electron 移行ロードマップ

## 背景

旧 scripta は Tauri v2 で実装されているが、WebView 起因の挙動不安定（macOS WKWebView での描画崩れ、リンククリックの挙動問題など）が継続的に発生していた。
Chromium 固定環境での挙動一貫性を優先し、Electron への全書き直しに踏み切る。

- 旧 issue 例: [#150 macOS プロダクションビルドでエディタが正しく表示されない](https://github.com/ymnao/scripta/issues/150), [#225 リンククリック挙動の改善](https://github.com/ymnao/scripta/issues/225)
- バンドルサイズが ~5MB → ~80–150MB へ増加するトレードオフは許容する

## 戦略

**big bang rewrite を別リポジトリで進める** が、開発自体は **Stage を切って段階的に** 進める。
旧 scripta は Stage 6 完了まで本番として稼働し続ける。

各 Stage の終わりで「日常的にドッグフードできるか」を判断基準にする。

## ステージ構成

### Stage 0: 雛形 + フロント表示確認（最大リスクの先行検証）

> **このステージのゴール**: 「旧 scripta のフロントエンドが Electron + Chromium で問題なく動作するか」を確認する。ここで重大な不具合が出たら方針見直しのチャンスがある。

- [ ] `package.json` を作成（`electron`、`electron-builder`、`electron-vite` または相当する Vite 連携、`react`、`react-dom`、`@vitejs/plugin-react`、`tailwindcss`、`@tailwindcss/vite`、Biome、Vitest を導入）
- [ ] `electron/main/index.ts` でウィンドウを生成。`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` を維持
- [ ] `electron/preload/index.ts` で `contextBridge` を経由した `window.api` 雛形を公開
- [ ] `vite.config.ts` を Electron 用に整備（`base: './'`、`@tailwindcss/vite`、`@vitejs/plugin-react`）
- [ ] 旧 scripta の `src/components/`, `src/stores/`, `src/hooks/`, `src/types/`, `src/lib/`（commands.ts 以外）, `src/styles/`, `index.html` を **コピーして** 持ち込む
- [ ] `src/lib/commands.ts` を **全モック実装** に差し替え（メモリ上の偽 fs、固定値の OGP、ダミーのワークスペース等）
- [ ] エディタが起動して、ハードコードされたサンプル Markdown を Live Preview で描画できる状態にする
- [ ] 旧 Tauri 版とビジュアル比較を行い、Chromium 固定での描画差異・既存バグの解消を確認

**完了判定**: Live Preview のすべてのデコレーション（見出し / 強調 / リンク / 画像 / コード / リスト / 引用 / 水平線 / テーブル / KaTeX / Mermaid / Wikilink / リンクカード / コードコピー）が Chromium で破綻なく表示される。

---

### Stage 1: ファイル I/O — 「実ファイルを編集できる」最小ライン

> **このステージのゴール**: 実ファイルを開いて編集して保存できる。ここから日常的にドッグフード可能になる。

- [ ] IPC ハンドラ実装: `read_file`, `write_file`, `create_file`, `create_directory`, `write_new_file`, `path_exists`, `file_exists`, `rename_entry`, `delete_entry`
- [ ] Node.js 側は `fs/promises` を使用。削除はゴミ箱移動（`@electron/remote` ではなく `electron.shell.trashItem` または `trash` パッケージ）
- [ ] パス検証ユーティリティ（ワークスペース外への書き込みを拒否する）
- [ ] `withRetry` 相当の指数バックオフリトライを Node 側 IPC ハンドラに移植
- [ ] エラーメッセージの日本語化（`translateError` 相当）を Node 側 → IPC 経由で統一する設計か、フロント側で行うかを決定
- [ ] `commands.ts` のモックを Stage 1 で実装した IPC 呼び出しに置換
- [ ] 旧版の `src/lib/errors.ts` 等を必要に応じて移植

**完了判定**: 旧 scripta で開いていたワークスペースを Electron 版でも開け、`.md` を読み・書き・保存できる。

---

### Stage 2: ワークスペース・ファイルツリー・ファイル監視

- [ ] `list_directory` を `fs/promises` で実装（遅延読み込み対応）
- [ ] `start_watcher` / `stop_watcher` を `chokidar` で実装し、`webContents.send` でイベント通知
- [ ] フロント側で受け取り、ファイルツリー再描画 / 開いているファイルの再読み込み
- [ ] `searchFilenames` をまず簡易実装（`fast-glob` ベースで OK、性能が必要になれば Stage 3 で ripgrep に統合）
- [ ] `scan_unresolved_wikilinks` を Node.js で再実装（旧 Rust 実装ロジックを移植）
- [ ] ワークスペース永続化: `electron-store` で前回開いていたフォルダパスを保存・復元

**完了判定**: フォルダを開く → ファイルツリー表示 → ファイルクリックで開く → 外部から変更すると反映、までが旧版と同等に動作する。

---

### Stage 3: 全文検索（ripgrep sidecar）

- [ ] `ripgrep` バイナリを各 OS 向けに `extraResources` で同梱する仕組みを整備
- [ ] `child_process.spawn` で ripgrep を起動し、JSON 出力をパースして `SearchResult[]` に整形
- [ ] `search_files` IPC を実装
- [ ] Stage 2 で簡易実装した `search_filenames` を ripgrep ベースに統一（任意）

**完了判定**: ワークスペース横断検索（`Cmd+Shift+F`）が旧版と同等以上の速度で動作する。

---

### Stage 4: Git Sync

- [ ] `simple-git` を導入し、旧 Rust の git コマンド一式を移植:
  - `git_check_available` / `git_check_repo` / `git_status` / `git_add_all` / `git_commit` / `git_pull` / `git_push`
  - `git_get_conflicted_files` / `git_get_conflict_content` / `git_resolve_conflict` / `git_finish_conflict_resolution`
  - `git_get_last_commit_time`
- [ ] コンフリクト解決画面用に独立ウィンドウを開けるようにする（旧版の `conflict-*` ウィンドウ相当）

**完了判定**: 自動コミット / プル / プッシュ / コンフリクト解決まで旧版と同じ UX で動作する。

---

### Stage 5: OGP / PDF / アップデート

- [ ] OGP: `undici` でフェッチ → `cheerio` でパース → `OgpData` に整形。SSRF 防御（プライベート IP / ループバック / リンクローカルのブロック）を main 側で行う
- [ ] PDF エクスポート: 隠しウィンドウ or `BrowserWindow` を spawn → `webContents.printToPDF` で PDF 生成
- [ ] HTML エクスポート / プロンプトエクスポート: 旧版のロジックをフロント側でほぼそのまま流用
- [ ] 自動アップデート: `electron-updater` を導入し、GitHub Releases ベースで配布

**完了判定**: リンクカード / PDF エクスポート / アップデートチェックが動作する。

---

### Stage 6: 仕上げ・配布・切り替え

- [ ] e2e テスト（Playwright `_electron` API）の整備。旧版から流用できるテストは流用する
- [ ] アプリケーションメニュー（macOS のメニューバー含む）の整備
- [ ] ウィンドウ状態の永続化（位置・サイズ・最大化状態）
- [ ] コードサイニング / 公証（macOS notarization、Windows EV 証明書）パイプラインを構築
- [ ] CI 整備: lint / typecheck / test / e2e / ビルド成果物アーティファクト化
- [ ] **機能パリティ確認** チェックリストを通し、旧版と同等以上であることを確認
- [ ] リリース切り替え: 旧 GitHub repo `ymnao/scripta` を `ymnao/scripta-tauri` 等にリネーム → 本リポジトリを `ymnao/scripta` として公開 → 自動アップデートのチャンネル設計を慎重に行う（旧版ユーザーへの移行案内）

**完了判定**: 旧版を archive にし、本リポジトリが本番運用に入る。

## 設計上の固定方針

- **Rust コードは持ち込まない**（Stage 3 の ripgrep のみ外部バイナリとして同梱）
- **`src/lib/commands.ts` は薄いラッパーに保つ** — IPC への差し替えポイントを集約することで、Stage 0 のモック → Stage 1 以降の本実装への移行を局所化する
- **セキュリティ設定は最初から強める** — `contextIsolation` / `nodeIntegration: false` / `sandbox: true` を Stage 0 から有効にし、後から緩めない
- **メイン側もユニットテストする** — IPC ハンドラはピュア関数として切り出し、Vitest でカバーする

## 旧リポジトリの参照ルール

旧 scripta（`/Users/nakiym/development/tools/scripta`）は本番稼働中なので **書き換えはしない**。
新規実装で旧版のコードを参考にしたい場合は絶対パスで読み込んで参照する。
