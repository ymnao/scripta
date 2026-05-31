# ADR-0001: PDF export タイムアウトを 300s（5 分）の単一予算とする

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

PDF export（`electron/main/ipc/pdf.ts:exportPdfImpl`）は、隠し `BrowserWindow` を専用 partition で生成し、以下の多段処理を直列に実行する:

1. HTML を OS tmpdir 配下の temp file に書き、`loadFile(tmpHtmlPath)` で file:// URL を load
2. `document.fonts.ready` を待つ（KaTeX 等のカスタムフォント読み込み完了の確認。`document.fonts` API が無い環境でも壊れないよう try/catch でガード）
3. 短時間の idle（`POST_LOAD_IDLE_MS = 100`）で DOM を安定化
4. `webContents.printToPDF(PDF_OPTIONS)` で Buffer を取得し、`write-file-atomic` で原子的に書き出す

各段の所要時間は文書の重さ（画像点数・数式量・ページ数）に大きく依存し、「重いが正常」な文書では各段が長くなり得る。一方、Chromium の load 後フックや font レンダリングが何らかの理由で完了しないと、`loadFile` 後の段で**無期限にハング**するケースがある（`pdf.test.ts` の `loadFileShouldHang` がこの失敗モードを模す）。

タイムアウト戦略として 2 案が見えていた:

- **A. 段ごとの個別タイムアウト** — load / fonts.ready / printToPDF にそれぞれ別の上限を割り当てる
- **B. export 全体に単一の予算** — 4 段をまとめて 1 つの上限で見る

段ごとの個別タイムアウトは、各段に「正常な重い文書でも越えうる短い上限」と「ハングを検知できる十分長い上限」を同時に満たす値を設定できず、**非対称な失敗モード**を生む。短く取れば重いが正常な文書を early-timeout し、長く取れば結局ハング検知が遅れる。段ごとに「正常上限」を見積もる根拠も乏しく、文書特性に応じてどの段が支配的かが変わるため、配分自体が恣意的になる。

## Decision

**export 処理全体に単一の予算 `PDF_EXPORT_TIMEOUT_MS = 300_000`（300s / 5 分）をかける（案 B）。**

実装は、4 段を 1 つの async work（`exportWork`）にまとめ、`Promise.race([exportWork, timeoutPromise])` で全体に 1 個の `setTimeout(300_000)` をかける形を取る（`pdf.ts:165-191`）。段ごとの個別タイムアウトは一切持たせない。timeout が race に勝った後に `exportWork` が遅れて reject しても unhandled rejection にならないよう、`exportWork.catch(() => {})` の no-op handler を attach する。

| 案 | Pros | Cons |
|---|---|---|
| A. 段ごとの個別タイムアウト | 各段の異常を細かく切り分けられる | 段ごとに「正常上限」と「ハング検知上限」を両立する値が取れず非対称な失敗モード（重い正常文書を誤 timeout / ハング検知が遅延）。配分が恣意的でメンテ負荷が高い |
| **B. export 全体に単一予算（採用）** | **単純で予測可能。「正常な重い文書を誤 timeout しない」「load 後にハングしても永遠には待たない」を 1 つの上限で両立。テストも「300_000ms の setTimeout が 1 度発生」を回帰として固定できる** | **どの段で詰まったかは予算超過からは判別できない（粒度は粗い）** |

### なぜ 5 分（300s）か

- **下限（誤 timeout を避ける）**: 大きな文書、多数の画像・数式（KaTeX レンダリング）を含むページでも、load → font ready → printToPDF が現実的に完了する余裕を確保する。秒〜十数秒オーダーの上限では正常な重い文書を誤って打ち切るリスクがある。
- **上限（ハングを永遠に待たない）**: load 後にレンダリングがハングしたケースを、ユーザーが「無限に応答しない」と感じる前に確実に失敗へ落とす。5 分はインタラクティブ操作としては明確に長く、これを越える export はほぼ確実に異常とみなせる。
- **旧版との一致**: 旧 Tauri 版 `src-tauri/src/commands/export.rs` が `PDF_EXPORT_TIMEOUT_SECS = 300` を採用しており、移行に際して同一の挙動上限を維持する（パリティ確保）。

## Consequences

### 良い影響

- 実装・挙動が単純で予測可能。タイムアウトに関する分岐が 1 箇所（単一の `setTimeout`）に集約される。
- 正常な重い文書（大量の画像・数式を含む長文）を誤って timeout しない。
- load 後のハングが無期限待ちにならず、上限 5 分で必ず失敗が返る。
- テストは「全体に 300_000ms の `setTimeout` が 1 度登録される」ことを spy で固定する（`pdf.test.ts:183` の `registers a 300s overall export timeout`）。fake timer での microtask 同期の難しさを避け、回帰検出を軽量に保てる。

### 注意すべき影響

- 粒度が粗く、どの段（load / fonts.ready / printToPDF）で詰まったかは予算超過からは判別できない。
- **UX 上の最悪待ち時間**: load 後にハングした場合、ユーザーは最大 5 分待たされてから失敗（「PDFエクスポートがタイムアウトしました」）が返る。進捗表示やキャンセル手段が無い現状では、この 5 分は体感上かなり長い。

### 関連する将来の検討事項

- export 中の**進捗フィードバック**（どの段にいるか、経過時間）を UI へ通知する。
- **キャンセル UI** の提供（ユーザーが 5 分を待たずに中断できる）。これがあれば「全体 5 分」上限の体感コストは大きく下がる。
- 進捗・キャンセルを導入する場合、段ごとの状態を観測する必要が出るため、本 ADR の「段ごとタイムアウトを持たない」方針とは別軸として整理する（観測と打ち切り上限は分離可能）。

## References

- Issue #84（Phase 3 PR-3-5）
- `electron/main/ipc/pdf.ts` — `PDF_EXPORT_TIMEOUT_MS = 300_000` 定数および `exportPdfImpl` の `Promise.race` 実装
- `electron/main/ipc/pdf.test.ts` — `registers a 300s overall export timeout`（300s 単一予算の回帰テスト）
- ADR-0000 — 設計判断を ADR に記録する（本 ADR の運用ルール）
