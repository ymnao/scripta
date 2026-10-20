# scripta（Electron 版）開発ガイドライン

> **このリポジトリの位置づけ**
>
> このリポジトリは、Tauri v2 で実装された旧 scripta（`~/development/tools/scripta/` および GitHub `ymnao/scripta-tauri`、現在は private）を **Electron へ全書き直し** したプロジェクト。
>
> 機能的なリファレンス・既存実装の参照元として、ローカル clone（`~/development/tools/scripta`）を参照する。新規実装は本リポジトリ側に行う。

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

**pnpm 11** + **Node.js 22 系**。具体的な version は `package.json` の `packageManager` と `engines.node` を正準として参照する（patch 版までこのドキュメントに書くと同期漏れの温床になるため、本セクションには major 表記のみ残している）。

設定の正準ロケーションは `pnpm-workspace.yaml`（`package.json:pnpm` フィールドは pnpm 11 で workspace.yaml への移行が推奨）。`overrides` / `allowBuilds` を同ファイルに集約。pnpm 11 の既定値（`minimumReleaseAge` / `blockExoticSubdeps` / `strictDepBuilds`）を明示宣言し、デフォルトが変わっても本リポジトリのポスチャを固定している。`minimumReleaseAge` の明示設定は副作用として `minimumReleaseAgeStrict=true`（24h 未満版しか無い場合は fallback せず失敗）を有効化するが、これは意図した挙動（詳細は `pnpm-workspace.yaml` のコメント参照）。

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

# 型チェック（tsconfig が node / web / e2e に分割された solution-style 構成のため、素の `tsc --noEmit` は root tsconfig の references を辿らず 0 ファイルチェックで exit 0 になる（沈黙の成功）。CI で落ちる型エラーの見逃しを防ぐには、push 前検証はこの script 経由か、直接叩くなら `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json && ./node_modules/.bin/tsc --noEmit -p tsconfig.web.json` の両方を明示指定する。ただし前者の `pnpm typecheck` script は先頭で `node scripts/generate-katex-css.js` を実行して `src/generated/katex-inline-css.ts` を生成しており、生成物が無い状態で 2 tsconfig を直叩きすると `src/lib/export.ts` の import が module not found で偽陽性の失敗になる点に注意。なお CI の typecheck job は `pnpm typecheck` に加えて `pnpm typecheck:e2e` も走らせるため、push 前は両方の実行が必要）
pnpm typecheck
pnpm typecheck:e2e

# ユニットテスト
pnpm test

# ユニットテストのカバレッジ（renderer / main。結果は coverage/。閾値・CI なし）
pnpm test:coverage

# e2e テスト（Playwright, renderer-only モード）
pnpm test:e2e

# e2e テスト（Playwright, 実 Electron 起動モード — build 成果物を _electron.launch）
pnpm test:e2e:electron
```

### electron 42+ への対応

electron 42.0.0 以降、バイナリ取得だけは自前の workaround を継続適用している（下記 1）。electron-vite 5 の頃に置いていた external 化と build target の明示は、electron-vite 6.0.0 への更新で外した（下記 2・3）。

#### 1. バイナリ取得（postinstall 削除への対応）

electron 42.0.0 で npm パッケージの `postinstall` script が削除され（[supply-chain 対策](https://github.com/electron/electron/pull/49328)）、`pnpm install` 時に electron バイナリが取得されなくなった。本プロジェクトでは 2 段構えで対応:

1. **`scripts.postinstall`** — fresh checkout / lockfile 変更時に `node node_modules/electron/install.js` を実行
2. **バイナリ依存 script への chain** — pnpm 10/11 の lockfile-unchanged 高速パス（lifecycle scripts skip）で postinstall がスルーされるケースに備え、`dev` / `preview` / `dist` / `test:e2e` / `test:e2e:ui` の頭でも同じ install.js をチェーン実行する。`install.js` はバイナリ存在時に即 return する idempotent script（~20ms）なので chain コストは無視可能

**`pnpm up electron@<ver>` 直後はこの 2 段構えのどちらにも乗らない**。新版の `node_modules/electron/` に `path.txt` が無い状態になり、`electron` を import する `electron/main/utils/remote-image-policy.test.ts` が `Electron failed to install correctly` で **suite ごと失敗**する（`test` script は install.js を chain していないため `pnpm test` でも解消しない）。依存 bump 後は `node node_modules/electron/install.js` を明示実行してからテストを回す。この失敗は 1 suite が丸ごと落ちる形なので、**pass 件数だけを見ると「全部通った」と誤読しやすい**（2026-09-26 の PR #562 で実際に誤読しかけた）。

#### 2. `electron` module の external 化（6.0.0 で撤去）

electron-vite の main / preload preset は、v5.0.0 / v6.0.0 とも external に `electron` と `/^electron\/.+/` を入れている（`src/plugins/electron.ts`）。2026-10-21 に electron-vite 6.0.0 + electron 44.9.0 で、`electron.vite.config.ts` に明示していた `rollupOptions.external` と target を外して build した。`out/main/index.js` / `out/preload/index.js` は外す前とバイト単位で同一（`diff -q`）で、electron の `index.js`（`path.txt` を読む処理）は含まれていなかった。これを確かめて明示指定を削除した。

#### 3. build target（6.0.0 で electron-vite のマップに委譲）

electron-vite は `package.json` の electron の major から、main / preload の `node?` と renderer の `chrome?` を決める（`getElectronNodeTarget()` / `getElectronChromeTarget()`、`src/electron.ts`）。6.0.0 のマップでは 44 → `node24.18` / `chrome152`。electron 44.9.0 の同梱版は Node v24.22.0 / Chromium 152.0.7977.167（`electron/electron` の `DEPS` を tag `v44.9.0` で取得して確認）。

マップに無い major では、マップ中で最も新しい major の値に fallback する（キーが整数文字列なので `Object.values()` は昇順に並び、その `reverse()[0]` が選ばれる）。fallback 先は実際の同梱版より古いので、変換が過剰になるだけで parse error にはならない。**Electron の major を上げるときは**、electron-vite のマップに新しい major が入っているかを見る。入っていなければ、同梱の Node / Chromium（上と同じ `DEPS` で確認）を `electron.vite.config.ts` の `build.target` に明示するかを判断する。`engines.node`（npm script を回すホスト Node の条件）は、Electron 同梱の runtime Node 版とは別物である点に注意。

## アーキテクチャ概要

```
scripta-next/                       # 作業ディレクトリ名（dev userData を本番 `scripta` から隔離する目的で `package.json:name` は scripta-next のまま）
├── electron/                       # Electron 本体（main / preload プロセス）
│   ├── main/                       # メインプロセス（Node.js 実行環境）
│   │   ├── index.ts                # エントリポイント・ウィンドウ管理・CSP・asset protocol 登録
│   │   ├── menu.ts                 # アプリケーションメニュー
│   │   ├── ipc/                    # IPC ハンドラ（旧 src-tauri/src/commands に対応）
│   │   │   ├── fs.ts               # ファイル読み書き・作成・削除・rename・パス検証
│   │   │   ├── workspace.ts        # フォルダ走査・ツリー取得
│   │   │   ├── search.ts           # 全文検索・ファイル名検索・wikilink/backlink scan（純 JS、旧 Rust ロジックを 1:1 移植）
│   │   │   ├── watcher.ts          # ファイル変更監視（chokidar）
│   │   │   ├── git.ts              # Git 操作（simple-git）
│   │   │   ├── ogp.ts              # OGP メタデータ取得（自前 http-fetch + 自前 ogp-parser、SSRF 防御）
│   │   │   ├── pdf.ts              # PDF エクスポート（webContents.printToPDF）
│   │   │   ├── update.ts           # アップデートチェック（GitHub Releases API ポーリング、存在確認のみ）
│   │   │   ├── settings.ts         # 設定永続化（app.getPath("userData")/settings.json、atomic write）
│   │   │   ├── window.ts           # ウィンドウ状態永続化（位置・サイズ・最大化状態）
│   │   │   ├── dialog.ts           # ファイル/フォルダ選択ダイアログ
│   │   │   └── shell.ts            # 外部 URL / ファイルオープン（shell.openExternal 等）
│   │   └── utils/                  # main 側の共通ユーティリティ
│   │       ├── path-guard.ts       # workspace 外パスの拒否（realpath 正規化 + window-scoped 認可）
│   │       ├── ssrf-guard.ts       # プライベート IP / loopback ブロック + DNS pin
│   │       ├── http-fetch.ts       # Node 標準 http(s).request ベースの HTTP ラッパー
│   │       ├── ogp-parser.ts       # 旧 Rust parse_ogp の 1:1 移植
│   │       ├── search-pure.ts      # UTF-16 lowerToOrig マップ等の純関数
│   │       ├── watcher-pure.ts     # watcher バッチ整形の純関数
│   │       ├── window-state.ts     # ウィンドウ状態の保存/復元（atomic）
│   │       ├── window-guards.ts    # navigation / new-window の許可判定
│   │       ├── permission-handler.ts # permission request 応答
│   │       ├── scripta-asset-protocol.ts # scripta-asset:// でローカル画像を配信
│   │       ├── structured-error.ts # IPC 経由のエラーフォーマット統一
│   │       ├── ipc-handle.ts       # ipcMain.handle ラッパー
│   │       └── ...                 # その他（entry-filter / git-validators / renderer-url / semver-lite 等）
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
├── e2e/                            # Playwright e2e（renderer-only モード）
│   └── electron/                   # 実 Electron 起動 e2e（_electron.launch, build 成果物）
├── electron-builder.yml            # 配布用ビルド設定
├── package.json
├── pnpm-workspace.yaml             # pnpm 11 設定（セキュリティ既定値 + overrides）
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
- `Decoration.line` は複数の plugin が同一行に付けうる (例: blockquote 内の fenced code 行は `.cm-blockquote-line` と `.cm-codeblock-line` の両方を持つ)。擬似要素 (`::before` / `::after`) で描く line 装飾を足すときは、同居しうる他の line 装飾が同じ擬似要素を使っていないか確認する。奪い合うと cascade で両方壊れる
- 行の高さを変える装飾を足したら、文字サイズの設定範囲の両端 (8 / 32px) で上下キーの移動を実測する。fence 行を固定 16px に潰した実装は、32px で `moveVertically` が fence 行を飛び越えた (#634)
- `extensions` 配列はコンポーネント外で定義するか `useMemo` でメモ化する

### Vite

- `electron.vite.config.ts` で renderer / main / preload を統合ビルド（`electron-vite` 採用済み）
- renderer 側は `@tailwindcss/vite` と `@vitejs/plugin-react` を使用
- Electron 向けに `base: './'` を設定（パッケージング後の相対パス読み込み対応）
- main / preload は `externalizeDepsPlugin` で依存を external 化（`electron` 自体は electron-vite の preset が external にする。上記「electron 42+ への対応」参照）

## ディレクトリ構成ルール

新しいファイルを追加する際は `docs/specification.md` のプロジェクト構成に従うこと。
勝手にディレクトリ構成を変更しない。

## テスト

- フロントエンドのユニットテストは Vitest を使用
- main プロセスのロジックも Vitest でカバーする（IPC ハンドラはピュア関数として切り出してテストする）
- e2e テストは Playwright を使用。**2 モード並行運用**（#33 / #82 C, Phase 1 PR-3 で確立）:
  - **renderer-only モード**（`e2e/*.spec.ts`, `playwright.config.ts`, `pnpm test:e2e`）— Vite dev server を起動し `e2e/helpers/electron-api-mock.ts` で `window.api` を注入。高速だが実 Electron / 実 main は起動せず、実 IPC payload のシリアライズ / contextBridge / preload の実装ミスは検出しない。UI ロジックの大半はこちらでカバー
  - **実 Electron 起動モード**（`e2e/electron/*.electron.spec.ts`, `playwright.electron.config.ts`, `pnpm test:e2e:electron`）— `electron-vite build` の成果物 (`out/main/index.js`) を `_electron.launch` で起動し、実 main + preload + 実 IPC を回す。起動毎に temp userData を切り (`--user-data-dir`)、設定永続化 / Settings migration / asset protocol / マルチウィンドウ等、mock では踏めない main 境界を safety net 化する。Tauri purge (Phase 2-5) の前後で現挙動を固定する目的（ヘルパーは `e2e/electron/helpers/`、CI は `electron-e2e` job で xvfb-run 実行）
- **コミット前に必ずユニットテストと e2e テストの両方を実行すること**（実 Electron モードは `pnpm test:e2e:electron` を別途実行）
- **新規 e2e のモード振り分け**: [ADR-0009](docs/adr/0009-renderer-only-e2e-strategy.md) §「各モードの役割分担（テスト分類方針）」を参照。
- **deferred promise pattern は `let x!: T` を使う** — test helper で `new Promise((resolve) => { resolveDeferred = resolve })` のように executor 内で外側の変数へ resolver を代入する慣用パターンでは、`let resolveDeferred: (() => void) | null = null` と宣言してから `resolveDeferred?.()` を呼ぶと TypeScript の CFA（TS 5.x / TS 7 いずれも同挙動、TS 7 固有ではなく長年の仕様）が nested function 内の再代入を後続 narrowing に反映せず `never` 型として TS2349 (`never has no call signatures`) を返す。`let resolveDeferred!: () => void`（definite assignment assertion）で宣言すると未代入チェックが「免除」される（同期実行される Promise executor が assertion を正当化する。コンパイラは同期性を検証せず作者責任で宣言する）ため解決する。

```bash
# コミット前の検証
# (format / lint / typecheck / typecheck:e2e / unit / e2e / build)
# CI の必須 job のうち electron-e2e を除いた分と parity。
# 実 Electron e2e は別途 `pnpm test:e2e:electron` で実行する。
pnpm verify
```

## Issue・PR

- PR は `.github/pull_request_template.md` のテンプレートに従って作成する
- Issue も既存テンプレートがあればそれに従う
- コミットメッセージは旧 scripta と同じ規約（`feat:` / `fix:` / `refactor:` / `perf:` / `test:` / `chore:` / `docs:` / `style:` の Type プレフィックス + 日本語 subject）に従う
- **merge 方式は全 PR squash merge**。このため merged branch のローカル削除は `git branch -d` が「未 merge」判定で拒否される（squash で SHA が変わるため git が原本 merge を認識できない）。merged 確認済み（`gh pr view <num> --json state`）のブランチ削除は `git branch -D` を使う。`/next` skill が `-d` 拒否で停止した場合も、対象 PR が merged であることを確認した上で `-D` に切り替える

## 旧リポジトリ参照ガイド

旧 scripta（Tauri 版）の実装を参照したい場合は、ローカル clone（`~/development/tools/scripta` 等、各自の clone path）から読み出す。

```
<旧 scripta clone>/src/...        # フロントエンド（流用元）
<旧 scripta clone>/src-tauri/...  # Rust バックエンド（再実装の参考に）
<旧 scripta clone>/docs/...       # 旧仕様書・実装手順書
<旧 scripta clone>/e2e/...        # 旧 e2e テスト（流用元）
```

旧リポジトリは参照専用（**書き換えは行わない**）。
