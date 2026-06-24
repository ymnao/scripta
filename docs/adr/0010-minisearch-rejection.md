# ADR-0010: 全文検索エンジンとして MiniSearch を採用しない（自前 line-level scan を維持）

- **Status**: Rejected
- **Date**: 2026-06-24

## Context

scripta の全文検索（`Cmd+Shift+F` のワークスペース横断検索）は、`electron/main/ipc/search.ts:searchFilesImpl` に純 JS の brute-force walk + line-by-line substring match として実装している（ADR-0009 の Stage 3 完了分）。具体的には:

- ワークスペース配下を再帰走査して `.md` ファイルを収集（`walkMdFiles`）
- 各ファイルを `fs.readFile` で読み、行単位に `line.indexOf(query)`（case-insensitive 時は lower 変換 + `buildLowerToOrigUtf16Map` で UTF-16 offset を逆引き）
- マッチごとに `{ filePath, lineNumber, lineContent, matchStart, matchEnd }` を返す
- 連続入力で古い search を中断するための per-window generation cancel

フロント側 `src/components/search/SearchPanel.tsx` はこれを **ファイル単位にグループ化 → 各ヒット行を行番号 + `<mark>` で位置 highlight** という VS Code 風の grep UX で表示する。e2e（`e2e/search.spec.ts:182-230`）は emoji・サロゲートペアでの `matchStart` / `matchEnd` 正確性まで含めてピン留めしている。

セッション 24 の deep-research で [MiniSearch](https://github.com/lucaong/minisearch)（zero-dep / BM25 / prefix / fuzzy / field boosting / `toJSON` `loadJSON` で index 永続化可）が local-first Markdown ノートアプリの全文検索基盤として確立されていることが共有された。Issue [#203](https://github.com/ymnao/scripta/issues/203) で次の観点で採否を検討する:

- BM25 ranking が scripta UX に合うか
- index 永続化方式（起動時 reindex / `<userData>` に persist / worker thread 切り出し）
- メモリ使用量（workspace 100 files / 1000 files の実測）
- 既存 brute-force walk と比べた性能優位性
- cross-platform 動作

なお `docs/migration-plan.md` Stage 3（line 66-80）で「旧 Rust の純文字列検索を 1:1 で TS 移植、ripgrep sidecar は YAGNI」「数百〜数千ファイルなら純 JS で十分」「数万規模で遅くなった場合は ripgrep バイナリ sidecar / Rust ネイティブモジュールへの置き換えを将来検討」という方針が既に確定している。本 ADR はその将来検討枠に対する正式な評価結果でもある。

## Decision

**MiniSearch は採用しない（Rejected）。** 全文検索は引き続き `electron/main/ipc/search.ts:searchFilesImpl` の brute-force walk + line-level substring match を維持する。

### 判断の核となる事実

1. **MiniSearch には文字位置 / 行番号を返す API が無い。** 公式 API リファレンス（[MiniSearch class](https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html), 2026-06-24 確認）の `search()` 戻り値 `SearchResult` は `id` / `score` / `terms` / `queryTerms` / `match`（term × field のマッチ情報）で、原文内の文字オフセットや行番号は提供されない。`tokenize` カスタマイズで token 位置を保持する非公式 workaround も検討余地はあるが、term 境界（CJK 等の word boundary）と CodeMirror が highlight する原文字符との整合は別途自前で再構築する必要があり、本質的な解決にならない。

2. **scripta の SearchPanel UX は position 付き grep**。`src/components/search/SearchPanel.tsx` はファイル単位グループの中で各ヒット行を `matchStart` / `matchEnd` で位置 highlight するため、文字位置の取得は機能仕様として必須。

3. **e2e で位置精度がピン留めされている**。`e2e/search.spec.ts:182-230` は emoji（`🎉🎊test`）・サロゲートペア（`😀hello world`）に対し、`.search-panel-highlight` の `<mark>` が "hello" / "test" だけを含み、サロゲートペアの破片を含まないことを断言する。MiniSearch 置換でこの粒度の position 精度を維持するのは現実的でない。

4. **scripta の想定規模では brute-force walk が十分高速**。「数百〜数千 .md」という想定（migration-plan.md Stage 3）で `fs.readFile` + 行 indexOf は数十〜数百 ms オーダーで返る。BM25 ranking が UX 改善に直結する「数万件超の検索コーパスで重要度ソート」という前提条件が、scripta の主要ユースケースには当てはまらない。

### 代替案比較

| 案 | Pros | Cons |
|---|---|---|
| MiniSearch 完全置換（UX を ranked file list に変更） | BM25 ranking / prefix / fuzzy を UX 表面に出せる、起動後検索が定数時間に近づく可能性 | char position API 不在で line-level highlight UX を直接実現できず、SearchPanel と e2e（emoji / サロゲートペア 位置検証）を全面再設計する必要がある、ranking-based UX は scripta の grep 用途と方向違い |
| Hybrid（MiniSearch で候補絞り → 既存 line scan で位置取得） | UX は維持しつつ ranking で順序化できる | 数百〜数千規模で brute-force walk が既に十分速いため絞り込み benefit が小さい、index 永続化 / 増分更新 / file watcher との同期コスト・並列モデル（worker thread / SharedArrayBuffer）の運用負荷が機能向上に見合わない、二重実装で保守コストが上がる |
| **自前 line-level scan 維持（採用）** | **既存の position 付き grep UX をそのまま維持、依存追加ゼロ、UTF-16 / emoji の位置精度ピン留めが継承される、IPC cancel / path-guard / search-pure（lower→orig map）等の既存機構と一貫**、旧 Rust 1:1 移植の本番実績を保持 | BM25 ranking / 全文 fuzzy / prefix 検索は提供できない（filename 検索は `searchFilenamesImpl` の自前 `fuzzyMatch` で別途対応済み）、数万件規模に育ったユーザーで遅延が出る可能性は将来検討枠に残す |

最終的に**自前 line-level scan 維持**を採用する。MiniSearch の主要機能（BM25 ranking, index 永続化）は scripta の現状 UX の本質的価値（grep 的「ファイル × 行 × 位置」の全マッチ表示）と直交しており、運用コストに対して得られる改善が見合わない。

## Consequences

### 良い影響

- 既存 SearchPanel UX（VS Code 風 grep、位置 highlight、ファイル単位グループ）が継続維持される。
- 依存追加ゼロで attack surface を増やさない（ADR-0005 の自前実装方針と一貫）。
- e2e（`e2e/search.spec.ts`）の emoji / サロゲートペア位置精度ピン留めが継承される。
- IPC cancel（per-window generation）、path-guard、`buildLowerToOrigUtf16Map`（UTF-16 lower→orig 逆引き）といった既存機構と整合が取れたまま。
- 起動時の index 構築コスト / `<userData>` への persist / worker thread 設計が不要。

### 注意すべき影響

- BM25 ranking、全文 prefix / fuzzy 検索といったランキング系機能は提供しない。ファイル名側の fuzzy 検索は既存 `searchFilenamesImpl`（`fuzzyMatch`）で別途対応済みのため、ranking 要件はファイル内全文側のみのギャップとして残る。
- ノート数が万単位に育ったユーザーが現れた場合、行 scan の wall-clock が体感に出る可能性がある（migration-plan.md 将来検討枠と同じ。閾値は未実測）。

### 関連する将来の検討事項

- workspace が万単位に拡大したユーザーが現れた / 計測でレンダリングが体感閾値を超えたタイミングで、ranking 系エンジンを再評価する。再評価時の選択肢候補:
  - MiniSearch の `tokenize` カスタムで token 位置保持 + 自前 highlight 再構築（CJK boundary 等の整合は要設計）
  - 文字位置 API を公式に持つ engine（候補: Orama, FlexSearch 等。本 ADR 時点で同等に未調査）
  - ripgrep sidecar / `napi-rs` ネイティブモジュール（migration-plan.md 将来検討枠の元案）
- 本 ADR を supersede する形で新規 ADR を起こす。
- 一方で「ranking より grep のままで良い」「数万件規模はこのアプリのターゲット外」という方向に解像度が上がれば、本 ADR を Accepted（恒久決定）に格上げする。

## References

- Issue [#203](https://github.com/ymnao/scripta/issues/203) — 全文検索エンジンに MiniSearch 採用を検討
- `electron/main/ipc/search.ts` — 現状 `searchFilesImpl` 実装
- `electron/main/utils/search-pure.ts` — `buildLowerToOrigUtf16Map`（UTF-16 lower→orig 逆引き）
- `src/components/search/SearchPanel.tsx` — VS Code 風 grep UX
- `e2e/search.spec.ts:182-230` — emoji / サロゲートペアでの位置 highlight ピン留め
- `docs/migration-plan.md` Stage 3（line 66-80）/ 将来検討枠（line 134-136）
- [MiniSearch 公式 API リファレンス](https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html)（2026-06-24 確認時点で `SearchResult` に char offset / line number 無し）
- 関連 ADR: [0005](0005-self-implemented-ogp-parser.md)（依存を増やさず自前 1 パス scan で完結させる同じ思想）/ [0009](0009-renderer-only-e2e-strategy.md)（e2e の grep 風 position ピン留めが含まれる layer）
