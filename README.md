# mark-draft

ローカルファイルベースの軽量 Markdown メモアプリケーション。
Obsidian のように任意のフォルダを「ワークスペース」として開き、Markdown ファイルを Live Preview 方式で編集できるデスクトップアプリ。

## コンセプト

- **ローカルファースト** — データはすべてユーザーのファイルシステム上の `.md` ファイル。独自フォーマットや DB は使わない
- **軽量・高速** — Tauri v2 による小さなバイナリサイズ（~5MB）、Rust バックエンドによる高速ファイル I/O
- **Live Preview** — カーソル外の Markdown をその場でインライン描画し、Split Pane なしで「書く」と「見る」を同時に実現

## 技術スタック

| レイヤー | 技術 | バージョン |
|---------|------|-----------|
| デスクトップフレームワーク | [Tauri](https://v2.tauri.app/) | v2 |
| フロントエンド | [React](https://react.dev/) + TypeScript | React 19 |
| エディタ | [CodeMirror 6](https://codemirror.net/) (`@uiw/react-codemirror`) | v6 |
| 状態管理 | [zustand](https://zustand.docs.pmnd.rs/) | v5 |
| スタイル | [Tailwind CSS](https://tailwindcss.com/) | v4 |
| ビルド | [Vite](https://vite.dev/) | v6+ |

## 前提条件

- Node.js >= 20
- Rust (latest stable)
- [Tauri v2 の前提条件](https://v2.tauri.app/start/prerequisites/)（OS ごとのシステム依存）

## セットアップ

```bash
# 依存のインストール
npm install

# 開発サーバー起動（Tauri + Vite HMR）
npm run tauri dev

# プロダクションビルド
npm run tauri build
```

## プロジェクト構成

```
mark-draft/
├── src-tauri/                    # Rust バックエンド
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands/
│   │   │   ├── workspace.rs      # フォルダ走査・ツリー取得
│   │   │   ├── file.rs           # ファイル読み書き・作成・削除
│   │   │   └── search.rs         # 全文検索・ファイル名検索
│   │   └── watcher.rs            # ファイル変更監視
│   ├── capabilities/             # Tauri v2 パーミッション設定
│   └── Cargo.toml
│
├── src/                          # React フロントエンド
│   ├── components/
│   │   ├── layout/               # AppLayout, Sidebar, TitleBar, StatusBar
│   │   ├── editor/
│   │   │   ├── MarkdownEditor.tsx
│   │   │   ├── extensions.ts
│   │   │   ├── themes.ts
│   │   │   ├── live-preview/     # Live Preview デコレーション群
│   │   │   └── TabBar.tsx
│   │   ├── filetree/             # FileTree, ContextMenu
│   │   ├── search/               # SearchPanel, CommandPalette
│   │   └── common/               # Dialog, ContextMenu
│   ├── stores/                   # zustand ストア
│   ├── hooks/                    # useAutoSave, useFileWatcher, useTheme 等
│   ├── lib/                      # Tauri コマンドラッパー、定数
│   └── types/                    # 型定義
│
├── docs/                         # 仕様書・実装手順書
├── package.json
└── vite.config.ts
```

## 主な機能

- **ワークスペース管理** — フォルダを開く・前回のワークスペースを記憶
- **ファイルツリー** — 階層表示・展開/折りたたみ・遅延読み込み・コンテキストメニュー
- **Markdown エディタ** — CodeMirror 6 ベースのテキスト編集・シンタックスハイライト
- **Live Preview** — 見出し・太字・斜体・リンク・画像・コードブロック・チェックボックス・引用・水平線のインライン描画（カーソル行は生 Markdown を表示）
- **タブバー** — 複数ファイルの同時編集・未保存インジケーター
- **オートセーブ** — 2 秒デバウンスによる自動保存
- **全文検索** — ワークスペース横断検索（`Cmd+Shift+F`）
- **クイックオープン** — ファイル名ファジー検索（`Cmd+P`）
- **ダーク/ライトテーマ** — CSS 変数ベースのテーマ切替
- **ファイル変更監視** — 外部エディタでの変更を自動反映

## キーボードショートカット

| ショートカット | 動作 |
|--------------|------|
| `Cmd+S` | ファイル保存 |
| `Cmd+P` | クイックオープン |
| `Cmd+Shift+F` | 全文検索 |
| `Cmd+B` | サイドバー表示/非表示 |
| `Cmd+W` | タブを閉じる |
| `Cmd+N` | 新規ファイル作成 |

## ドキュメント

- [仕様書](docs/specification.md)
- [実装手順書](docs/implementation-guide.md)

## ライセンス

MIT
