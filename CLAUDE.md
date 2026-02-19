# mark-draft 開発ガイドライン

## プロジェクト概要

ローカルファイルベースの軽量 Markdown メモアプリケーション。
Tauri v2 + React 19 + CodeMirror 6 + zustand v5 + Tailwind CSS v4 + Vite + Biome + Vitest。
パッケージマネージャは pnpm を使用。

## 開発コマンド

```bash
# 開発サーバー起動（Tauri + Vite HMR）
pnpm tauri dev

# プロダクションビルド
pnpm tauri build

# フロントエンドのみ起動（Tauri なし、UI 確認用）
pnpm dev

# lint
pnpm lint

# lint（自動修正）
pnpm lint:fix

# フォーマット
pnpm format

# 型チェック
pnpm typecheck

# テスト
pnpm test

# Rust テスト
cd src-tauri && cargo test
```

## コーディング規約

### TypeScript

- **`any` 型の使用は禁止** — Biome の `noExplicitAny` ルールで強制。`unknown` + 型ガード、ジェネリクス、適切な型定義で対応する
- 型定義は `src/types/` に集約
- Tauri コマンドのラッパーは `src/lib/commands.ts` に配置
- `invoke` の戻り値には必ず型引数を指定する（`invoke<string>('read_file', { path })`）

### React

- 関数コンポーネントのみ使用（クラスコンポーネント禁止）
- `ref` は通常の prop として渡す（React 19 では `forwardRef` 不要）
- `useRef` には必ず引数を渡す（`useRef<HTMLDivElement>(null)`）
- ref コールバックで暗黙的な return をしない（ブロック構文 `ref={node => { ... }}` を使用）
- コンポーネントは機能ごとのディレクトリに配置:
  - `src/components/layout/` — TitleBar, Sidebar, StatusBar, AppLayout
  - `src/components/editor/` — MarkdownEditor, TabBar, extensions, themes
  - `src/components/editor/live-preview/` — 各デコレーション（headings, emphasis, links 等）
  - `src/components/filetree/` — FileTree, ContextMenu
  - `src/components/search/` — SearchPanel, CommandPalette
  - `src/components/common/` — Dialog 等の共通 UI

### 状態管理（zustand v5）

- ストアは `src/stores/` に配置
- TypeScript ではカリー化パターンを使用: `create<StateType>()((...) => ({ ... }))`
- オブジェクト/配列を返すセレクタには `useShallow` を使用して不要な再レンダリングを防ぐ
- CodeMirror の内部状態は zustand と過剰に同期しない（CM6 が自身の状態を管理）
- named import のみ使用（`import { create } from 'zustand'`）

### スタイル（Tailwind CSS v4）

- CSS ファイルで `@import "tailwindcss"` を使用（`@tailwind` ディレクティブは v4 では非推奨）
- テーマは `@theme` ディレクティブで CSS 変数として定義
- ダークモードは `@custom-variant dark (&:where(.dark, .dark *))` で定義
- `tailwind.config.js` は使用しない（v4 は CSS-first 設定）
- Vite プラグイン `@tailwindcss/vite` を使用

### Tauri v2（Rust バックエンド）

- ファイル I/O は全て Rust コマンド経由（フロントエンドから直接ファイルアクセスしない）
- コマンドは `src-tauri/src/commands/` に機能別に配置
  - `file.rs` — ファイル読み書き・作成・削除
  - `workspace.rs` — フォルダ走査・ツリー取得
  - `search.rs` — 全文検索・ファイル名検索
- コマンドは `#[tauri::command]` マクロで定義し、`lib.rs` の `invoke_handler` に登録
- エラーは `Result<T, String>` 型で返す
- パーミッション設定は `src-tauri/capabilities/` に配置
- Rust 側の引数は `snake_case`、JS 側では `camelCase` で呼び出す（Tauri が自動変換）

### Live Preview（CodeMirror 6）

- `ViewPlugin` + `Decoration` API を使用（StateField ではなく ViewPlugin を使う）
- `syntaxTree()` で `@lezer/markdown` のパースツリーを取得
- デコレーションは `RangeSetBuilder` で構築（位置順に追加必須）
- カーソルがある行ではデコレーションを適用しない
- `update` メソッドでは `docChanged || viewportChanged || selectionSet || treeChanged` をチェック
- `WidgetType` サブクラスには `eq()` を実装して不要な DOM 再生成を防ぐ
- 各デコレーションは `src/components/editor/live-preview/` に独立ファイルで配置
- `extensions` 配列はコンポーネント外で定義するか `useMemo` でメモ化する

### Vite

- `vite.config.ts` で `@tailwindcss/vite` と `@vitejs/plugin-react` を使用
- Tauri 向けに `server.strictPort: true` を設定
- `envPrefix` に `'TAURI_'` を含める

## ディレクトリ構成ルール

新しいファイルを追加する際は仕様書のプロジェクト構成に従うこと。
勝手にディレクトリ構成を変更しない。

## テスト

- フロントエンドのユニットテストは Vitest を使用
- Rust 側のテストは `cargo test`
