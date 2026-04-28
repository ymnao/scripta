# scripta（Electron 版・開発中）

> **本リポジトリは現在開発中** です。
> 旧 [scripta（Tauri 版）](https://github.com/ymnao/scripta) を Electron へ全書き直しするためのリポジトリ。
> リリース時に本リポジトリが新 `scripta` として公開される予定。
> 開発期間中の作業ディレクトリ名は `scripta-next`。

ローカルファイルベースの軽量 Markdown メモアプリケーション。
Obsidian のように任意のフォルダを「ワークスペース」として開き、Markdown ファイルを Live Preview 方式で編集できるデスクトップアプリ。

## なぜ Electron 版を作るのか

旧 scripta は Tauri v2 で実装されており、軽量バイナリ（~5MB）というメリットがある一方で、各 OS の WebView（macOS の WKWebView、Windows の WebView2、Linux の WebKitGTK）の差異に起因する挙動不安定が継続的に発生していた。

具体的には:
- macOS プロダクションビルドでエディタが正しく表示されない（旧 [#150](https://github.com/ymnao/scripta/issues/150)）
- リンククリックで意図した動作にならない（旧 [#225](https://github.com/ymnao/scripta/issues/225)）

Chromium 固定環境で挙動を安定させるため、バンドルサイズ（~80–150MB）増加を許容して Electron へ移行する。

## コンセプト（変更なし）

- **ローカルファースト** — データはすべてユーザーのファイルシステム上の `.md` ファイル。独自フォーマットや DB は使わない
- **挙動の安定性** — Electron + Chromium で全プラットフォーム共通の描画・動作
- **Live Preview** — カーソル外の Markdown をその場でインライン描画し、Split Pane なしで「書く」と「見る」を同時に実現

## 技術スタック

| レイヤー | 技術 | バージョン |
|---------|------|-----------|
| デスクトップフレームワーク | [Electron](https://www.electronjs.org/) | latest stable |
| フロントエンド | [React](https://react.dev/) + TypeScript | React 19 |
| エディタ | [CodeMirror 6](https://codemirror.net/) (`@uiw/react-codemirror`) | v6 |
| 状態管理 | [zustand](https://zustand.docs.pmnd.rs/) | v5 |
| スタイル | [Tailwind CSS](https://tailwindcss.com/) | v4 |
| ビルド | [Vite](https://vite.dev/) + [electron-vite](https://electron-vite.org/) | Vite 7 / electron-vite 5 |
| Lint / Format | [Biome](https://biomejs.dev/) | v2 |
| テスト | [Vitest](https://vitest.dev/) + [Playwright](https://playwright.dev/) | latest |
| パッケージング | [electron-builder](https://www.electron.build/) | latest |
| パッケージマネージャ | [pnpm](https://pnpm.io/) | v10+ |

## 開発状況

`docs/migration-plan.md` の Stage 0〜6 で進行する。

- [ ] Stage 0: 雛形 + フロント表示確認
- [ ] Stage 1: ファイル I/O
- [ ] Stage 2: ワークスペース・ファイルツリー・ファイル監視
- [ ] Stage 3: 全文検索（ripgrep sidecar）
- [ ] Stage 4: Git Sync
- [ ] Stage 5: OGP / PDF / アップデート
- [ ] Stage 6: 仕上げ・配布・切り替え

## 前提条件

- Node.js `^20.19.0 || >=22.12.0`（Vite 7 / electron-vite 5 / Vitest 4 の要件）
- pnpm >= 10

## セットアップ

> Stage 0 で `package.json` を整備するまでは未動作。

```bash
# 依存のインストール
pnpm install

# 開発サーバー起動（Electron + Vite HMR）
pnpm dev

# プロダクションビルド
pnpm build

# 配布用パッケージング
pnpm dist

# lint / format
pnpm lint
pnpm format

# テスト（ユニット）
pnpm test

# テスト（e2e、Stage 6 で整備予定）
# pnpm test:e2e
```

## ドキュメント

- [仕様書](docs/specification.md) — Electron 版の最終形
- [移行計画](docs/migration-plan.md) — Stage 0〜6 のロードマップ
- [開発ガイドライン](CLAUDE.md) — コーディング規約・アーキテクチャ概要

## 旧リポジトリ

- [ymnao/scripta](https://github.com/ymnao/scripta) — Tauri v2 版（本番稼働中）
- ローカル: `/Users/nakiym/development/tools/scripta`

旧版は Stage 6 完了まで継続稼働する。本リポジトリのリリース時に旧版を archive とし、新 scripta として切り替える予定。

## ライセンス

MIT
