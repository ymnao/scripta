# scripta（Electron 版）開発ガイドライン

> **このリポジトリの位置づけ**
>
> このリポジトリは、Tauri v2 で実装された旧 scripta（`~/development/tools/scripta/` および GitHub `ymnao/scripta`）を **Electron へ全書き直し** したプロジェクト。
>
> 旧リポジトリ（参照専用）: `/Users/nakiym/development/tools/scripta`
> 旧リポジトリは新版への移行完了まで稼働継続するため、機能的なリファレンス・既存実装の参照元として活用する。新規実装は本リポジトリ側に行う。

> **TODO（リポジトリリネーム時に更新、[issue #28](https://github.com/ymnao/scripta-next/issues/28)）**
>
> 現状の作業ディレクトリ名は `scripta-next`（リネーム前）。issue #28 完了時に以下を更新する:
>
> - 作業ディレクトリ名を `scripta` に統一
> - GitHub remote URL: `ymnao/scripta-next` → `ymnao/scripta`（旧 Tauri 版は `ymnao/scripta-tauri` 等へリネーム）
> - `electron/main/ipc/update.ts:GITHUB_API_URL` を `scripta` へ戻す
> - 本 TODO blockquote 自体を削除

## プロジェクト概要

ローカルファイルベースの軽量 Markdown メモアプリケーション。
Electron + React 19 + CodeMirror 6 + zustand v5 + Tailwind CSS v4 + Vite + Biome + Vitest。
パッケージマネージャは pnpm を使用。

## 移行方針

`docs/migration-plan.md` に Stage 0〜6 のロードマップを定義している。新機能の実装はその段階順序に従って進める。

- 旧 Tauri 版のフロントエンド（`src/components/`, `src/stores/`, `src/hooks/`, `src/lib/` の一部, `src/types/`）はほぼそのまま流用する
- バックエンド境界（`src/lib/commands.ts`）を Electron IPC へ差し替えることが移行の中心作業となる
- Stage 0 ではバックエンド処理を全てモック実装にして、まず frontend が Chromium で動作することを検証する
- Rust コードはこのリポジトリには持ち込まない。全文検索など性能が必要なものも純 JS で実装する（旧 Rust ロジックを 1:1 移植、`docs/migration-plan.md` Stage 3 参照）

## パッケージマネージャ

**pnpm 11.1.1**、Node.js **22.13.0 以上必須**（pnpm 11.1.1 の `engines.node` が `>=22.13` のため。`engines.node` も同じ値に揃えてある）。

設定の正準ロケーションは `pnpm-workspace.yaml`（`package.json:pnpm` フィールドは pnpm 11 で workspace.yaml への移行が推奨）。`overrides` / `patchedDependencies` / `allowBuilds` を同ファイルに集約。pnpm 11 の既定値（`minimumReleaseAge` / `blockExoticSubdeps` / `strictDepBuilds`）を明示宣言し、デフォルトが変わっても本リポジトリのポスチャを固定している。`minimumReleaseAge` の明示設定は副作用として `minimumReleaseAgeStrict=true`（24h 未満版しか無い場合は fallback せず失敗）を有効化するが、これは意図した挙動（詳細は `pnpm-workspace.yaml` のコメント参照）。

## 開発コマンド

```bash
# 依存インストール（postinstall で electron バイナリ取得スクリプトが走る）
pnpm install

# 開発サーバー起動（Electron + Vite HMR）
pnpm dev

# プロダクションビルド
pnpm build

# Electron パッケージング（インストーラ生成）
pnpm dist

# lint
pnpm lint

# lint（自動修正）
pnpm lint:fix

# フォーマット
pnpm format

# 型チェック
pnpm typecheck

# ユニットテスト
pnpm test

# e2e テスト（Playwright）
pnpm test:e2e
```

### electron 42 への対応

electron 42.0.0 のリリースに伴って 2 種類の workaround が必要になった。`electron-vite@5.0.0` が 42 に未対応のため過渡期の対応（[alex8088/electron-vite#904](https://github.com/alex8088/electron-vite/issues/904) が landed したら両方削除予定）。

#### 1. バイナリ取得（postinstall 削除への対応）

electron 42.0.0 で npm パッケージの `postinstall` script が削除され（[supply-chain 対策](https://github.com/electron/electron/pull/49328)）、`pnpm install` 時に electron バイナリが取得されなくなった。本プロジェクトでは 2 段構えで対応:

1. **`scripts.postinstall`** — fresh checkout / lockfile 変更時に `node node_modules/electron/install.js` を実行
2. **バイナリ依存 script への chain** — pnpm 10/11 の lockfile-unchanged 高速パス（lifecycle scripts skip）で postinstall がスルーされるケースに備え、`dev` / `preview` / `dist` / `test:e2e` / `test:e2e:ui` の頭でも同じ install.js をチェーン実行する。`install.js` はバイナリ存在時に即 return する idempotent script（~20ms）なので chain コストは無視可能

#### 2. `electron` module の external 化

`electron` は devDependencies に置く慣例で、`externalizeDepsPlugin` のデフォルトは dependencies のみを external にするため、`@electron-toolkit/utils` 経由の transitive ESM import から electron の `index.js` が bundle に取り込まれる。electron 41 までは index.js が単純な path 返却だったので bundle されても害が小さかったが、42 から lazy download ロジックが index.js に追加された結果、bundle 後の `__dirname` が `path.txt` を見失って `Electron failed to install correctly` エラーで起動失敗するようになった。

`electron.vite.config.ts` の main / preload で `rollupOptions.external: ['electron', /^electron\/.+/]` を明示指定して runtime resolve に戻す。

## アーキテクチャ概要

```
scripta-next/
├── electron/                       # Electron 本体（main / preload プロセス）
│   ├── main/                       # メインプロセス（Node.js 実行環境）
│   │   ├── index.ts                # エントリポイント・ウィンドウ管理
│   │   ├── ipc/                    # IPC ハンドラ（旧 src-tauri/src/commands に対応）
│   │   │   ├── file.ts             # ファイル読み書き・作成・削除
│   │   │   ├── workspace.ts        # フォルダ走査・ツリー取得
│   │   │   ├── search.ts           # 全文検索・ファイル名検索（純 JS、旧 Rust ロジックを 1:1 移植）
│   │   │   ├── git.ts              # Git 操作（simple-git）
│   │   │   ├── ogp.ts              # OGP メタデータ取得（自前 http-fetch + 自前 ogp-parser、SSRF 防御）
│   │   │   ├── pdf.ts              # PDF エクスポート（webContents.printToPDF）
│   │   │   ├── update.ts           # アップデートチェック（GitHub Releases API ポーリング、存在確認のみ）
│   │   │   └── watcher.ts          # ファイル変更監視（chokidar）
│   │   └── menu.ts                 # アプリケーションメニュー
│   └── preload/                    # プリロードスクリプト（contextBridge で window.api を公開）
│       └── index.ts
│
├── src/                            # React フロントエンド（旧 scripta から流用）
│   ├── components/                 # （旧と同一構成）
│   ├── stores/                     # zustand ストア
│   ├── hooks/                      # React フック
│   ├── lib/
│   │   └── commands.ts             # 旧 invoke() ラッパーを window.api 呼び出しへ差し替え
│   └── types/                      # 型定義
│
├── docs/                           # 仕様書・実装計画
├── e2e/                            # Playwright e2e テスト（renderer-only モード）
├── electron-builder.yml            # 配布用ビルド設定
├── package.json
├── pnpm-workspace.yaml             # pnpm 11 設定（セキュリティ既定値 + overrides + patches）
├── electron.vite.config.ts         # electron-vite で renderer / main / preload を統合ビルド
└── biome.json
```

## コーディング規約

### TypeScript

- **`any` 型の使用は禁止** — Biome の `noExplicitAny` ルールで強制。`unknown` + 型ガード、ジェネリクス、適切な型定義で対応する
- 型定義は `src/types/`（フロント側）または `electron/main/types/`（main 側）に集約
- IPC 経由のコマンドは `src/lib/commands.ts` に薄いラッパーを集約する（旧 Tauri 版の `commands.ts` の構造を踏襲）
- 戻り値には必ず型を明示する

### IPC（Electron）

- メインプロセスとレンダラ間の通信は **必ず `contextBridge` 経由** で行う（直接 `ipcRenderer` を露出させない）
- `electron/preload/index.ts` で `window.api.<command>` を定義し、`src/lib/commands.ts` 側はそれを呼ぶだけにする
- セキュリティ設定: `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` を維持
- ハンドラは `electron/main/ipc/` 以下に機能別ファイルで配置
- エラーは throw せず `Promise.reject(new Error(...))` で返し、フロント側で `try/catch`
- パス検証: ワークスペース外のパスへの read/write は main 側で必ず弾く（パストラバーサル防御）

### React

- 関数コンポーネントのみ使用（クラスコンポーネント禁止）
- `ref` は通常の prop として渡す（React 19 では `forwardRef` 不要）
- `useRef` には必ず引数を渡す（`useRef<HTMLDivElement>(null)`）
- ref コールバックで暗黙的な return をしない（ブロック構文 `ref={node => { ... }}` を使用）
- コンポーネントは機能ごとのディレクトリに配置:
  - `src/components/layout/` — Sidebar, StatusBar, AppLayout
  - `src/components/editor/` — MarkdownEditor, TabBar（タイトルバー兼用・ドラッグ領域）, extensions, themes
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

- `electron.vite.config.ts` で renderer / main / preload を統合ビルド（`electron-vite` 採用済み）
- renderer 側は `@tailwindcss/vite` と `@vitejs/plugin-react` を使用
- Electron 向けに `base: './'` を設定（パッケージング後の相対パス読み込み対応）
- main / preload は `externalizeDepsPlugin` で依存を external 化（electron 42 対応で `rollupOptions.external` も明示、上記「electron 42 への対応」参照）

## ディレクトリ構成ルール

新しいファイルを追加する際は `docs/specification.md` のプロジェクト構成に従うこと。
勝手にディレクトリ構成を変更しない。

## テスト

- フロントエンドのユニットテストは Vitest を使用
- main プロセスのロジックも Vitest でカバーする（IPC ハンドラはピュア関数として切り出してテストする）
- e2e テストは Playwright を使用（**現状は renderer-only モード** — Vite dev server を起動し `e2e/helpers/electron-api-mock.ts` で `window.api` を注入する構成。実 Electron / 実 main プロセスは起動せず、実 IPC payload のシリアライズ / contextBridge / preload の実装ミスは検出しない。実 Electron 起動の `_electron` API ベース e2e は v1.0.0 昇格条件として将来追加予定、`docs/parity-checklist.md` § 13 項目 5 参照）
- **コミット前に必ずユニットテストと e2e テストの両方を実行すること**

```bash
# コミット前の検証
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

## Issue・PR

- PR は `.github/pull_request_template.md` のテンプレートに従って作成する
- Issue も既存テンプレートがあればそれに従う
- コミットメッセージは旧 scripta と同じ規約（`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `style:` の Type プレフィックス + 日本語 subject）に従う

## 旧リポジトリ参照ガイド

旧 scripta（Tauri 版）の実装を参照したい場合は絶対パスで読み出す。

```
/Users/nakiym/development/tools/scripta/src/...        # フロントエンド（流用元）
/Users/nakiym/development/tools/scripta/src-tauri/...  # Rust バックエンド（再実装の参考に）
/Users/nakiym/development/tools/scripta/docs/...       # 旧仕様書・実装手順書
/Users/nakiym/development/tools/scripta/e2e/...        # 旧 e2e テスト（流用元）
```

旧リポジトリは引き続き本番稼働中のため、**書き換えは行わない**（参照専用）。
