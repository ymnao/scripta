# ADR-0009: e2e は renderer-only + 実 Electron の 2 モード並行で運用する

- **Status**: Accepted
- **Date**: 2026-06-01

## Context

Electron 移行（Issue #81 / Tauri purge）の e2e は、旧 Tauri 版が `playwright-tauri` 経由で実 Tauri バイナリを起動していた構成を、移行の暫定措置として **renderer-only モード**（Vite dev server + `e2e/helpers/electron-api-mock.ts` で `window.api` を `addInitScript` 注入）に置き換えた状態で運用されてきた。

renderer-only モードは高速・並列・CI コストが低い一方、**実 Electron / 実 main プロセスを起動しない**ため、次の main 境界の regression を構造的に検出できない（issue #86 サブタスク A で列挙）:

- IPC payload の serialization 不一致（contextBridge 越しの構造化クローン制約）
- contextBridge 経由の API 漏れ / 命名ズレ（`window.api.*` の表面）
- preload script の実 ready 状態（`contextIsolation` 越しの公開タイミング）
- protocol handler（`scripta-asset://`）の実 fetch と path-guard
- file watcher（`chokidar`）の実イベントフロー
- 実 OS のファイル操作（`fs:write` の path-guard 通過と実ディスク反映、`shell.trashItem` 等）
- 設定永続化 / Settings migration（実 `<userData>/settings.json` 読み書き）
- マルチウィンドウ（conflict window の単一インスタンス管理）
- 重量 widget の production renderer 描画（mermaid SVG / PDF printToPDF）

Tauri purge（Phase 2〜5）は main 境界に大きく手を入れるため、これらを mock の外側で固定する safety net が必要になった。Issue #33（Playwright `_electron` API ベース最小 e2e）が当初「任意・1 本」として起票されていたが、Phase 1 PR-3（#82 C）で前倒しし、実 Electron 起動モードを本格導入した。

本 ADR は、両モードを **どちらか一方に統合せず並行運用する**という設計判断と、各モードの守備範囲・CI ポリシーを記録する。

## Decision

**e2e を 2 モード並行で運用する。** renderer-only モードを UI ロジックの主力（広く・速く）に据え、実 Electron 起動モードを main 境界の safety net（狭く・深く）に据える。両者は別 config / 別ディレクトリ / 別 CI job に分離する。

| モード | 構成 | testDir / config | CI job |
|---|---|---|---|
| **renderer-only** | Vite dev server + `window.api` mock 注入 | `e2e/*.spec.ts` / `playwright.config.ts` | `e2e`（必須） |
| **実 Electron 起動** | `electron-vite build` 成果物 `out/main/index.js` を `_electron.launch` | `e2e/electron/*.electron.spec.ts` / `playwright.electron.config.ts` | `electron-e2e`（必須・full） |

### 各モードの役割分担（テスト分類方針）

- **renderer-only で書く**: UI 状態遷移・キーボード操作・ダイアログ・デコレーション・mock で十分な分岐（例: export ダイアログのセクション切替や `isPdfSupported` の UI ゲート）。テストの大多数はこちら。
- **実 Electron で書く**: mock では踏めない main 境界に限定する。1 spec = 1「領域」（main 境界）に対応させ、`smoke` を土台に以下を safety net 化する:

  | 領域 | spec | 検証する main 境界 |
  |---|---|---|
  | smoke | `smoke.electron.spec.ts` | 起動パイプライン + contextBridge 表面 |
  | 設定永続化 | `settings-persistence.electron.spec.ts` | 実 `settings.json` 読み書き・再起動復元 |
  | Settings migration | `settings-migration.electron.spec.ts` | legacy `theme` → `themePreference` 移行 |
  | Asset URL | `asset-url.electron.spec.ts` | `scripta-asset://` protocol + path-guard |
  | 画像描画 | `image-rendering.electron.spec.ts` | live-preview 画像の実 protocol ロード |
  | Window labels | `window-labels.electron.spec.ts` | conflict window 単一インスタンス |
  | ファイルライフサイクル | `file-lifecycle.electron.spec.ts` | 実 fs CRUD + 再起動跨ぎのディスク永続化 |
  | Mermaid 描画 | `mermaid-rendering.electron.spec.ts` | production renderer での mermaid SVG 描画 |
  | PDF エクスポート | `pdf-export.electron.spec.ts` | `printToPDF` + write path-guard + atomic write |

### CI ポリシー

**実 Electron e2e（`electron-e2e` job）は full suite を必須（blocking）として実行する。** Issue #86 サブタスク D は「smoke のみ必須・full は非 blocking」を示唆していたが、Tauri purge の safety net としては回帰検出力を優先し、全 spec を blocking のままにする（ユーザー判断, 2026-06-01）。Electron 起動は重いため、worker を CI で 2 に絞り、`retries: 1`・xvfb-run でヘッドレス実行することでコストと安定性のバランスを取る。

### PDF / Mermaid の capability vs product ゲート

`ExportDialog` の PDF ボタンは `isPdfSupported`（`navigator.userAgent` が mac/win）で無効化される **product レベル**の制約であり、capability（`webContents.printToPDF` 自体）は Linux を含む全 OS で動作する。したがって PDF の実 Electron spec は UI を経由せず IPC（`window.api.exportPdf`）を直接呼んで capability 境界を検証する（Linux CI でも実行可能）。UI ゲートの分岐は renderer-only `export.spec.ts` がカバーする。この役割分担が「同じ機能を 2 モードで重複検証しない」原則の具体例。

## Consequences

### 良い影響

- main 境界の regression（IPC serialization / preload / protocol / 永続化 / printToPDF）を CI で検出できる。
- renderer-only の高速性を UI テストの主力として維持できる。
- 1 spec = 1 領域の対応で、実 Electron spec が「何の安全網か」を追跡しやすい。

### 注意すべき影響

- 実 Electron e2e は起動が重く、CI 実行時間を押し上げる。worker 数・retry・必須範囲の調整で継続的にバランスを見る必要がある。
- 起動毎に temp `--user-data-dir` を切るため、cleanup（`rmSync`）の取りこぼしに注意（fixtures で teardown 済み）。
- 2 モードの責務分担を崩すと重複検証が発生する。新規 e2e は「mock で踏めるか」を基準にモードを選ぶ。

### 関連する将来の検討事項

- file watcher（`chokidar`）・全文検索（`search`）・git 操作は現状 renderer-only + Vitest unit でカバーし、実 Electron spec 化は未了。回帰が顕在化したら領域を追加する。
- packaged build（`pnpm dist` 成果物）のスモークは本 e2e とは別レイヤ（Issue #26 / parity-checklist §10）。
- `electron-vite@5` の Electron 42 対応 landed 後、build target workaround と合わせて launch helper を見直す。

## References

- Issue [#86](https://github.com/ymnao/scripta-next/issues/86)（Phase 4: テスト精査）/ 親 [#81](https://github.com/ymnao/scripta-next/issues/81)
- Issue [#33](https://github.com/ymnao/scripta-next/issues/33)（Playwright `_electron` API e2e）— Phase 1 PR-3 で実装し **closed**、本 Phase へ合流（別 Issue として残さない）
- `docs/parity-checklist.md` §10（e2e カバレッジ）
- 関連 ADR: [0002](0002-scripta-asset-protocol.md)（asset protocol）/ [0006](0006-settings-migration-policy.md)（settings migration）/ [0008](0008-structured-fs-error.md)（IPC structured error）
