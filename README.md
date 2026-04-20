# scripta

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
| ビルド | [Vite](https://vite.dev/) | v8+ |
| Lint / Format | [Biome](https://biomejs.dev/) | v2 |
| テスト | [Vitest](https://vitest.dev/) | v4+ |
| パッケージマネージャ | [pnpm](https://pnpm.io/) | v9+ |

## インストール

[GitHub Releases](https://github.com/ymnao/scripta/releases) からお使いの OS に合ったインストーラをダウンロードしてください。

### macOS

1. `.dmg` ファイルをダウンロード
2. `.dmg` を開き、`scripta.app` を `/Applications` にドラッグ&ドロップ
3. Gatekeeper によりアプリが開けない場合は、ターミナルで以下を実行：
   ```bash
   xattr -cr /Applications/scripta.app
   ```

### Windows

`.exe`（セットアップウィザード）または `.msi` をダウンロードしてインストールしてください。

### Linux

`.deb` / `.rpm` / `.AppImage` のいずれかをダウンロードしてインストールしてください。

## 前提条件

- Node.js >= 20
- Rust (latest stable)
- [Tauri v2 の前提条件](https://v2.tauri.app/start/prerequisites/)（OS ごとのシステム依存）

## セットアップ

```bash
# 依存のインストール
pnpm install

# 開発サーバー起動（Tauri + Vite HMR）
pnpm tauri dev

# プロダクションビルド
pnpm tauri build

# lint / format
pnpm lint
pnpm format

# テスト
pnpm test
```

## プロジェクト構成

```
scripta/
├── src-tauri/                    # Rust バックエンド
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── commands/
│   │   │   ├── workspace.rs      # フォルダ走査・ツリー取得
│   │   │   ├── file.rs           # ファイル読み書き・作成・削除
│   │   │   ├── search.rs         # 全文検索・ファイル名検索
│   │   │   ├── git_sync.rs       # Git 操作（commit/pull/push/conflict）
│   │   │   ├── export.rs         # HTML/PDF/プロンプト エクスポート
│   │   │   ├── ogp.rs            # OGP メタデータ取得
│   │   │   └── watcher.rs        # ファイル変更監視
│   ├── capabilities/             # Tauri v2 パーミッション設定
│   └── Cargo.toml
│
├── src/                          # React フロントエンド
│   ├── components/
│   │   ├── layout/               # AppLayout, Sidebar, StatusBar, NewTabContent
│   │   ├── editor/
│   │   │   ├── MarkdownEditor.tsx
│   │   │   ├── TabBar.tsx
│   │   │   ├── ScratchpadPanel.tsx
│   │   │   ├── MermaidEditorDialog.tsx
│   │   │   ├── editor-theme.ts
│   │   │   ├── formatting-commands.ts
│   │   │   └── live-preview/     # Live Preview デコレーション群
│   │   ├── filetree/             # FileTree, FileTreeItem, ContextMenu
│   │   ├── search/               # SearchPanel, CommandPalette, UnresolvedLinksPanel
│   │   ├── slide/                # SlideView, SlidePreview
│   │   ├── conflict/             # ConflictWindow, ConflictDiffView
│   │   └── common/               # Dialog, EmojiInputDialog, ExportDialog, SettingsDialog 等
│   ├── stores/                   # zustand ストア（workspace, git-sync, scratchpad, drag 等）
│   ├── hooks/                    # useAutoSave, useFileWatcher, useGitSync 等
│   ├── lib/                      # Tauri コマンドラッパー、export, slide-parser, mermaid 等
│   └── types/                    # 型定義（workspace, git-sync, slide, wikilink 等）
│
├── docs/                         # 仕様書・実装手順書
├── package.json
└── vite.config.ts
```

## 主な機能

### エディタ

- **Markdown エディタ** — CodeMirror 6 ベースのテキスト編集・シンタックスハイライト
- **Live Preview** — 見出し・太字・斜体・リンク・画像・コードブロック・チェックボックス・引用・水平線・テーブル・数式（KaTeX）・Mermaid 図のインライン描画（カーソル行は生 Markdown を表示）
- **タブバー** — 複数ファイルの同時編集・未保存インジケーター・タブ履歴の前後移動
- **オートセーブ** — 2 秒デバウンスによる自動保存
- **スクラッチパッド** — ワークスペースに依存しない揮発性のメモ領域（`Cmd+J`）
- **Wikilink** — `[[ページ名]]` 形式でノート間リンク・自動補完・ホバープレビュー・未解決リンク一覧
- **Mermaid 図** — コードブロック内の Mermaid をリアルタイム描画・専用エディタダイアログ
- **数式** — KaTeX による LaTeX 数式描画
- **リンクカード** — リンク先の OGP 情報をカード表示

### ワークスペース

- **ワークスペース管理** — フォルダを開く・前回のワークスペースを記憶
- **ファイルツリー** — 階層表示・展開/折りたたみ・遅延読み込み・コンテキストメニュー・ドラッグ&ドロップ並び替え
- **絵文字アイコン** — ファイル/フォルダに絵文字アイコンを設定（全 Unicode 絵文字対応・検索機能付き）
- **全文検索** — ワークスペース横断検索（`Cmd+Shift+F`）
- **コマンドパレット** — ファイル名ファジー検索（`Cmd+P`）
- **ファイル変更監視** — 外部エディタでの変更を自動反映

### Git Sync

- **自動コミット** — 設定した間隔で変更を自動コミット
- **自動プル/プッシュ** — リモートとの同期を自動化
- **コンフリクト解消** — 競合発生時の差分表示・手動解決 UI

### 表示・エクスポート

- **スライドビュー** — `---` 区切りで Markdown をスライドとして表示（`Cmd+Shift+S`）
- **エクスポート** — HTML / PDF / プロンプト（LLM 用）形式でエクスポート（`Cmd+Shift+E`）
- **ダーク/ライトテーマ** — CSS 変数ベースのテーマ切替（システム設定連動）

## キーボードショートカット

### 書式

| ショートカット | 動作 |
|--------------|------|
| `Cmd+B` | 太字（エディタ内） |
| `Cmd+I` | 斜体 |
| `Cmd+Shift+X` | 取り消し線 |
| `Cmd+1`〜`6` | 見出し 1〜6 |
| `Cmd+L` | リストの切り替え |
| `Cmd+Shift+L` | チェックボックスの切り替え |
| `Cmd+Enter` | チェック / チェック解除 |

### ファイル

| ショートカット | 動作 |
|--------------|------|
| `Cmd+S` | 保存 |
| `Cmd+T` | 新しいタブ |
| `Cmd+W` | タブを閉じる |
| `Cmd+[` / `Alt+←` | 戻る |
| `Cmd+]` / `Alt+→` | 進む |

### ナビゲーション

| ショートカット | 動作 |
|--------------|------|
| `Cmd+Shift+[` | 前のタブ |
| `Cmd+Shift+]` | 次のタブ |
| `Cmd+G` | 指定行へジャンプ |

### 検索

| ショートカット | 動作 |
|--------------|------|
| `Cmd+F` | 検索 |
| `Cmd+H` | 置換 |
| `Cmd+P` | コマンドパレット |
| `Cmd+Shift+F` | ワークスペース検索 |

### 表示

| ショートカット | 動作 |
|--------------|------|
| `Cmd+B` | サイドバーの切り替え（エディタ外） |
| `Cmd+Shift+S` | スライドビュー |
| `Cmd+J` | スクラッチパッド |
| `Cmd+E` | ファイルエクスプローラー |
| `Cmd+Shift+E` | エクスポート |
| `Cmd+Shift+U` | 未解決リンク |
| `Cmd+,` | 設定 |
| `F1` | ヘルプ |

## ドキュメント

- [仕様書](docs/specification.md)
- [実装手順書](docs/implementation-guide.md)

## ライセンス

MIT
