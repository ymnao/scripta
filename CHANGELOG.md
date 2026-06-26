# Changelog

すべての注目すべき変更はこのファイルに記録する。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/spec/v2.0.0.html) に従う。

## [0.6.0] — 2026-06-27

v0.5.0 リリース後の内部品質改善ラウンド。ユーザー向け振る舞い変更はなく、refactor 7 件を集約。zustand selector の useShallow 適用 (#206)、settings migration の versioned array 化 (#208)、2 モード e2e の振り分け基準明文化 (#207)、wikilink target query 経由の in-editor highlight (#225)、3 panel 共通 collapse hook の抽出 (#226)、scan store の race-prevention pattern factory 化 (#228)、backlink scan の producer-side trim による render-time allocation 削減 (#227) を実施。

### Internal

- **AppLayout の workspace selector に `useShallow` を適用** (#206 → #229): zustand store selector が tabs 配列の参照同一性に依存して不要な再 render を起こしていた問題を、`useShallow` で構造比較に切り替えて解消
- **settings に `_schemaVersion` を導入し migration を versioned array 化** (#208 → #230): `loadSettings()` が ad-hoc な `delete s.theme` 等の inline migration を持っていた構造を、`MIGRATIONS: ReadonlyArray<{ from: number; to: number; run(ctx): void }>` 形式の versioned array に置換。将来の non-idempotent migration や `_schemaVersion` field 自体の write 順序を一元化できるように整備
- **2 モード e2e の重複 spec を整理 + 振り分け基準を ADR-0009 に集約** (#207 → #231): renderer-only モード (Vite + window.api mock) と実 Electron 起動モード (`_electron.launch`) の 2 モード e2e で発生していた重複 spec を整理し、各モードでカバーすべき範囲の振り分け基準を ADR-0009 §「各モードの役割分担」に canonical 化
- **BacklinkPanel / UnresolvedLinksPanel の onNavigate に wikilink target を query として渡す** (#225 → #232): backlink / unresolved wikilink から navigate した先のエディタで、ジャンプ元の wikilink target を query string として渡すことで in-editor highlight が走るようにし、SearchPanel と同等の UX に統一
- **3 panel 共通の `useCollapseToggle` hook を抽出** (#226 → #233): SearchPanel / BacklinkPanel / UnresolvedLinksPanel で重複していた collapse toggle ロジック (`useState(() => new Set())` + lazy init + `reset` の re-render skip 含む) を `useCollapseToggle` として抽出
- **backlink / wikilink store の `_scanId` race-prevention pattern を `createScanAction` factory に共通化** (#228 → #234): backlink store / wikilink store の scan action が同一構造で重複保持していた `_scanId` increment + race check + `Omit<Partial<TState>, "_scanId" | "loading">` 型による不変条件防御パターンを `createScanAction` factory として共通化。3 件目の scanner store 追加時の同パターン再実装コストを削減
- **backlink / unresolved wikilink scan で `lineContent` を producer 側で 1 度 trim する** (#227 → #235): `iterateWikilinkOccurrences` helper が yield する `WikilinkReference` の `lineContent` を producer 側で 1 度 `line.trim()` し、consumer (BacklinkPanel render-time / `buildInitialContent`) の冗長な `.trim()` 呼び出しを排除。e2e mock も対称に trim 化 (ADR-0009 parity)

## [0.5.0] — 2026-06-24

v0.4.0 リリース後の機能追加 + セキュリティ補強ラウンド。バックリンクパネル (#202) とタブ切替 undo 履歴消失修正 (#220) を主軸に、Electron security checklist Tier 1 補完 (#204)、CI セキュリティスキャン 3 件追加 (#205)、undici / dompurify advisory 解消、全文検索エンジン MiniSearch 採用検討 (#203) を ADR-0010 で Rejected として記録。あわせて CI 必須 check と paths-ignore の罠 (docs-only PR が永遠に BLOCKED になる GitHub 仕様) を codeql-skip stub workflow で恒久対策。

### Added

- **バックリンクパネル** (#202 → #221): 現在開いているノートを `[[ファイル名]]` で参照している他ノートをサイドパネルに一覧表示。**Cmd+Shift+B** でトグル。CommonMark / Lezer 準拠の inline code span / fenced code 範囲判定で、fenced code 内・inline code 内・escape された wikilink は除外。basename 衝突解決は lexicographically smallest path を canonical 扱い。`iterateWikilinkOccurrences` を共通 helper として抽出し `scanUnresolvedWikilinks` との 70 行重複を解消。専用 `backlinkGeneration` map で search / wikilink scan とは独立にキャンセル管理

### Fixed

- **タブ切替で undo 履歴が失われる問題を修正** (#220 → #222): CodeMirror EditorState を `<MarkdownEditor key={editorKey}>` の remount で破棄していたため、タブ間で Cmd+Z 履歴が失われていた。`historyField` を含む JSON snapshot (`view.state.toJSON({ history: historyField })`) をタブごとに cache に保存し、戻った時に最新 extensions で `EditorState.fromJSON()` → `view.setState()` で組み立て直す設計に変更。あわせて file watcher 経由 cache 更新で editorState フィールドが drop されていた問題を `setCacheFromReload` ヘルパーに集約して解決、SearchBar の listener 注入 effect を `viewEpoch` で再走させ `view.setState()` 後の compartment 消失に対応

### Security

- **Electron security checklist Tier 1 補完 3 件** (#204 → #210):
  - `session.defaultSession` に `setPermissionRequestHandler` / `setPermissionCheckHandler` を install、notifications / media / geolocation 等 web permission を常に明示 deny (Electron Security Checklist Item #5。`electron/main/utils/permission-handler.ts`)
  - `fs:read` に **64MB** サイズ上限 (`MAX_READ_FILE_BYTES`) を導入。読み込み前に `fs.stat` で確認し上限超は `StructuredError("FILE_TOO_LARGE")` を throw。他 handler (OGP 100KB / git conflict 10MB) と上限思想を揃え、`ErrorKind` / renderer 側 `translateError` / `NON_TRANSIENT_KINDS` にも追従
  - `SCRIPTA_PDF_DEBUG_HTML_PATH` debug 出力経路を `is.dev` ガードで本番 disable
- **CI セキュリティスキャン 3 件追加** (#205 → #218):
  - **CodeQL** (`.github/workflows/codeql.yml` 新規): JS/TS 静的解析を push to main / PR / weekly schedule (日曜 05:30 UTC) で実行
  - **dependency-review** (ci.yml に job 追加): PR diff で新規追加される依存に既知 advisory が無いか gate (`fail-on-severity: high`)
  - **pnpm audit 定期実行** (`.github/workflows/audit.yml` 新規): weekly schedule (月曜 06:30 UTC) で advisory 検出時に issue 自動作成、既存 open issue があれば `gh issue comment` で append
  - action SHA pin、cron 時間分散 (±15min ジッタ考慮の :30 選定)、`actions/checkout` に `persist-credentials: false`、`security-audit` label 冪等作成、CodeQL concurrency group の schedule/push 分離など防御層を多段で整備
  - **branch protection 必須 checks を `[lint, typecheck, test, build, e2e, electron-e2e, dependency-review, "Analyze (javascript-typescript)"]` の 8 件に拡張**
- **CI 必須 check と paths-ignore の罠を codeql-skip stub workflow で恒久対策** (PR #223): 必須 check 化された CodeQL workflow が `paths-ignore: ["**/*.md", "docs/**", ".github/ISSUE_TEMPLATE/**"]` で trigger されない場合、その PR は永遠に BLOCKED になる GitHub 仕様。同名 check (`Analyze (javascript-typescript)`) を補完的な paths filter で trigger する stub workflow (`.github/workflows/codeql-skip.yml`) を追加し、docs-only PR でも必須 check が成立するように
- **undici security advisory 9 件を parent>child override で解消** (#201): `@electron/get` / `jsdom` 経由の `undici 7.25.0` を `^7.28.0`、`node-gyp` 経由の `6.25.0` を `^6.27.0` に固定。Dependabot alert #10-14 / #17-20 を closed 化

### Internal

- **ADR-0010: 全文検索エンジン MiniSearch 採用を Rejected として記録** (#203 → #223):
  - 公式 `SearchResult` API には char offset / line number を返す手段が無く、SearchPanel の grep UX (matchStart/matchEnd 付き位置 highlight) を直接置換できない
  - 既存 e2e (`e2e/search.spec.ts:182-230`) で emoji / サロゲートペア位置精度がピン留めされ、UX 変更は機能 regression リスク
  - 数百〜数千 .md 想定で brute-force walk は十分高速、index 永続化 / worker thread 等の運用コストが UX 向上に見合わない
  - 代替案 3 件比較 (完全置換 / hybrid / 維持) で「自前 line-level scan 維持」を採用。将来検討枠 (workspace 万単位ユーザー出現時の再評価) として Orama / FlexSearch / ripgrep sidecar / napi-rs / MiniSearch tokenize 拡張を明示

### Dependencies

v0.4.0 → v0.5.0 で更新された主要パッケージ (Dependabot 8 件を集約、#199 + #211-#217 → #219):

- **dependencies**:
  - `@codemirror/search` `^6.7.0` → `^6.7.1`
  - `dompurify` `^3.4.10` → `^3.4.11` (#199)
  - `js-yaml` `^4.2.0` → `^5.0.0` (major; default import 廃止 → `import { load }` 形式へ、本体型同梱で `@types/js-yaml` 削除)
  - `lucide-react` `^1.18.0` → `^1.21.0`
- **devDependencies**:
  - `@playwright/test` `^1.60.0` → `^1.61.0`
  - `@types/node` `^25.9.3` → `^26.0.0` (major; 型のみ)
  - `electron` `^42.4.0` → `^42.4.1`
  - `vitest` `^4.1.8` → `^4.1.9`
- **CI actions**:
  - `actions/checkout` v6.0.3 → v7.0.0 (major; SHA pin 更新、`pull_request_target` / `workflow_run` の fork PR ブロックは本リポ未使用で実害なし)
- **削除**:
  - `@types/js-yaml` (js-yaml v5 本体に型同梱)

## [0.4.0] — 2026-06-20

v0.3.0 リリース後の patch / 内部品質改善ラウンド。OS 判定 (`navigator.platform` / `userAgent`) の集約ポリシーを Biome plugin で機械的に強制し、ショートカット表示文字列の構築も `platform.ts` 定数経由へ統一。あわせて Dependabot 9 件と security advisory 5 件をまとめて解消。

### Internal

- **platform 判定集約の機械的強制**: `src/lib/platform.ts` ヘッダで宣言済みの集約ポリシー (「ここからだけ import する」) を GritQL plugin (`plugins/no-navigator-platform.grit`) で lint レベルに引き上げ。dot / optional chain / bracket / destructuring / namespace prefix の各形式を弾き、PR レビューでの見落としを防ぐ。本体側に残っていた違反 2 箇所 (`ExportDialog.tsx` の `navigator.userAgent`、`tables.test.ts` の `navigator.platform`) も解消。あわせて `IS_WINDOWS` を `IS_MAC` と同抽象度で追加 (#180 → #186)
- **MarkdownEditor のショートカット表示を platform 定数で組み立てる**: 取り消し線 / テーブル挿入の `IS_MAC ? "⇧⌘X" : "Ctrl+Shift+X"` 形式の hardcode を `${SHIFT_MOD_SYMBOL}X` 形式に置換。`SHIFT_MOD_SYMBOL` 定数を新設し、`SHIFT_KEY_LABEL` + `PRIMARY_MOD_SYMBOL` を直接連結したときの `+` 欠落 (`ShiftCtrl+X`) を構造的に防ぐ。回帰テストも定数レベル / call site レベルの 2 層で追加 (#181 → #197)
- **.gitignore に MCP / AI agent 関連の local cache を追加**: `.serena/` と `AGENTS.md` を ignore 化 (#196)

### Security

- **5 件の security advisory を parent>child override で解消**: esbuild (high) / form-data (high) / tar (moderate) / @babel/core (low) / dompurify (low)。`pnpm-workspace.yaml` の `overrides` を global syntax ではなく parent>child syntax (`electron-vite>esbuild` 等) で表現し、alert 入口に限定して別 transitive への過剰干渉を回避 (#195)

### Dependencies

v0.3.0 → v0.4.0 で更新された主要パッケージ (Dependabot 7 PR + 9 bump を集約) (#194):

- **dependencies**:
  - `@codemirror/view` `^6.43.0` → `^6.43.1`
  - `dompurify` `^3.4.7` → `^3.4.10`
  - `lucide-react` `^1.17.0` → `^1.18.0`
- **devDependencies**:
  - `@biomejs/biome` `^2.4.16` → `^2.5.0`
  - `@tailwindcss/vite` `^4.3.0` → `^4.3.1`
  - `@types/node` `^25.9.2` → `^25.9.3`
  - `electron` `^42.3.0` → `^42.4.0`
  - `electron-builder` `^26.8.1` → `^26.15.3`
  - `tailwindcss` `^4.3.0` → `^4.3.1`

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

[0.6.0]: https://github.com/ymnao/scripta/releases/tag/v0.6.0
[0.5.0]: https://github.com/ymnao/scripta/releases/tag/v0.5.0
[0.4.0]: https://github.com/ymnao/scripta/releases/tag/v0.4.0
[0.3.0]: https://github.com/ymnao/scripta/releases/tag/v0.3.0
[0.2.0]: https://github.com/ymnao/scripta/releases/tag/v0.2.0
