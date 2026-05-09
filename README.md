# scripta

ローカルファイルベースの軽量 Markdown メモアプリケーション。
Obsidian のように任意のフォルダを「ワークスペース」として開き、Markdown ファイルを Live Preview 方式で編集できるデスクトップアプリ。

旧 [Tauri v2 版](https://github.com/ymnao/scripta) を Electron へ全書き直しした版で、Chromium 固定環境による挙動の一貫性を重視している。**初回リリースは v0.2.0 を予定**（リリース前のため `Releases` ページにはまだ配布物はない）。

## コンセプト

- **ローカルファースト** — データはすべてユーザーのファイルシステム上の `.md` ファイル。独自フォーマットや DB は使わない
- **挙動の安定性** — Electron + Chromium で全プラットフォーム共通の描画・動作
- **Live Preview** — カーソル外の Markdown をその場でインライン描画し、Split Pane なしで「書く」と「見る」を同時に実現

## 移行の経緯

旧 scripta は Tauri v2 で実装されており、軽量バイナリ（~5MB）というメリットがある一方で、各 OS の WebView（macOS の WKWebView、Windows の WebView2、Linux の WebKitGTK）の差異に起因する挙動不安定が継続的に発生していた。

具体的には:
- macOS プロダクションビルドでエディタが正しく表示されない
- リンククリックで意図した動作にならない

Chromium 固定環境で挙動を安定させるため、バンドルサイズ（~80–150MB）増加を許容して Electron へ移行した。

## 技術スタック

| レイヤー | 技術 | バージョン |
|---------|------|-----------|
| デスクトップフレームワーク | [Electron](https://www.electronjs.org/) | v42 |
| フロントエンド | [React](https://react.dev/) + TypeScript | React 19 |
| エディタ | [CodeMirror 6](https://codemirror.net/) (`@uiw/react-codemirror`) | v6 |
| 状態管理 | [zustand](https://zustand.docs.pmnd.rs/) | v5 |
| スタイル | [Tailwind CSS](https://tailwindcss.com/) | v4 |
| ビルド | [Vite](https://vite.dev/) + [electron-vite](https://electron-vite.org/) | Vite 8 / electron-vite 5 |
| Lint / Format | [Biome](https://biomejs.dev/) | v2 |
| テスト | [Vitest](https://vitest.dev/) + [Playwright](https://playwright.dev/) | latest |
| パッケージング | [electron-builder](https://www.electron.build/) | latest |
| パッケージマネージャ | [pnpm](https://pnpm.io/) | v10+ |

## インストール

v0.2.0 リリース後、[Releases](https://github.com/ymnao/scripta-next/releases) からプラットフォーム別のインストーラを取得できる予定。それまではソースから `pnpm dev` で動作確認可能。

<!-- TODO: リポジトリリネーム時（issue #28）に上記 URL を https://github.com/ymnao/scripta/releases に戻す -->

> 配布バイナリは **未署名で出荷する方針**（旧 Tauri 版同等）。macOS の Gatekeeper / Windows の SmartScreen による警告が出る場合は、各 OS の手順で手動で起動許可を行う。

## 開発

### 前提条件

- Node.js `^20.19.0 || >=22.12.0`（Vite 8 / electron-vite 5 / Vitest 4 の要件）
- pnpm >= 10

### コマンド

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

# 型チェック
pnpm typecheck

# テスト（ユニット）
pnpm test

# テスト（e2e）
pnpm test:e2e
```

## ドキュメント

- [仕様書](docs/specification.md) — Electron 版の機能仕様
- [移行計画](docs/migration-plan.md) — Tauri → Electron 移行の Stage ロードマップ
- [パリティチェックリスト](docs/parity-checklist.md) — 旧 Tauri 版との機能パリティ確認、リリース前ブロッカー、v1.0.0 昇格条件
- [開発ガイドライン](CLAUDE.md) — コーディング規約・アーキテクチャ概要

## ライセンス

MIT
