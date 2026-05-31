# ADR-0000: 設計判断を ADR に記録する

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

Tauri → Electron 移行に伴うコード整理 (Tauri 完全除去、Issue #81) では、新版コード中に散在する「旧 Tauri 版 X の Y を Z で置換」型のドキュメンタリーコメントを **完全削除** する方針を取った (HANDOFF.md「コード内コメントは『完全削除』方針」参照)。

この方針には以下のトレードオフがある:

- ✅ コードベースから Tauri 言及がゼロになり、新規開発者が Electron アプリとして素直に読める
- ❌ 「なぜこの実装になっているか」という設計上の根拠 (例: ある定数値が旧版と揃えてある理由、ある関数 API 形状が旧版エラー経路に合わせてある理由) が失われる

特に以下のような根拠は **コードから消えても恒久的に追跡可能** であるべき:

- 旧 Tauri 版 userData の継続利用判断 (`app.setName("scripta")`)
- PDF export timeout を 5 分に設定している経緯
- IPC error message が文字列 regex parse 前提なまま残っている経緯と、構造化エラーへの移行計画 (Phase 5)
- 非自明なライブラリ選定 (`simple-git` vs `nodegit` 等) の決定理由

これらをコードコメントとして残すと「旧 Tauri 版」言及が永久に残り、削除方針と矛盾する。一方で `docs/migration-plan.md` や `docs/parity-checklist.md` は時系列の移行記録であり、決定単位での横断的な参照には向いていない。

## Decision

`docs/adr/` ディレクトリを新設し、設計判断を Michael Nygard 形式の ADR (Architecture Decision Record) として 0000 から番号順に蓄積する。

### 運用ルール

- **形式**: `docs/adr/NNNN-kebab-case-title.md`（4 桁 zero-padded）
- **テンプレート**: `docs/adr/template.md` をコピーして使う
- **必須セクション**: Status / Context / Decision / Consequences
- **Status の値**:
  - `Proposed` — レビュー前 / 議論中
  - `Accepted` — 合意済み・有効
  - `Deprecated` — 過去の決定だが置き換えられた (Superseded by ADR-XXXX を併記)
  - `Rejected` — 検討したが採用せず
- **書き換え禁止**: 一度 `Accepted` になった ADR は変更しない。方針変更時は **新規 ADR を起こして supersede する**。元 ADR は `Deprecated` に書き換え、Status 行のみ更新可
- **コード側からの参照**: 必要なら `// see docs/adr/0001-...md` の形でリンクして良い (ただし「`docs/adr/` を見る」というメタ参照に留め、判断内容のコピーは置かない)
- **ADR 番号**: 0000 を本 ADR、0001 以降を実際の設計判断に使う

### スコープ

ADR に記録するのは以下のような **横断的・恒久的な設計判断**:

- アーキテクチャ選定 (Electron / React / CodeMirror / zustand 等の理由)
- 旧 Tauri 版との互換維持判断 (userData / settings.json format / bundle ID 等)
- セキュリティポスチャ (CSP / context isolation / path-guard / SSRF guard 等)
- ライブラリ選定の代替検討結果
- パフォーマンス / バンドルサイズ trade-off の判断

以下は ADR に書かない:

- 一時的な workaround (コードコメントで十分)
- 実装手順 (`docs/migration-plan.md` 側)
- 機能パリティ確認 (`docs/parity-checklist.md` 側)
- ユーザー向け機能仕様 (`docs/specification.md` 側)

## Consequences

### 良い影響

- コードから Tauri 言及を完全除去しても設計判断は失われない
- 横断的決定 (例: 「Settings 互換維持」) を 1 箇所で参照できる
- 過去の Rejected 案 (例: `nodegit` を選ばなかった理由) も追跡可能
- 新規開発者が「なぜこうなっているか」を ADR 一覧で俯瞰できる

### 注意すべき影響

- ADR を **書き忘れる** リスク: コードレビュー時に「これは ADR 対象では?」を継続的に問う必要がある
- ADR の **過剰化**: 些末な決定まで ADR 化すると 100 件単位に膨張する。「横断的・恒久的」フィルタを厳しく適用する
- ADR の **陳腐化**: Deprecated への更新を怠ると古い決定が誤読される。新規 ADR で supersede した際は元 ADR の Status 行を必ず更新する

### Phase 1 完了後の初期 ADR 候補

Phase 1 (#82) PR-1 では本 ADR (0000) のみ作成し、以下を後続 Phase で起こす:

- **ADR-0001** 旧 Tauri 版 userData の互換維持と撤去タイミング (Phase 3 で `electron/main/index.ts:30-36` コメント削除と同時)
- **ADR-0002** Settings format (`settings.json`) の互換維持判断 (Phase 3 同時)
- **ADR-0003** `convertFileSrc` → `buildAssetUrl` リネームと preload API surface の Chromium-idiomatic 化 (Phase 3 同時)
- **ADR-0004** IPC error の structured 化判断 (Phase 5、`fs-errors.ts` ↔ `errors.ts` regex parse の刷新)

実際に起こす ADR と番号は Phase 進行に応じて確定する (本 ADR の見積もりはあくまで候補)。

## References

- Michael Nygard, "Documenting Architecture Decisions" (2011) — ADR 形式の原典
- [adr.github.io](https://adr.github.io/) — ADR 一般リファレンス
- Issue #81 — Tauri 完全除去トラッカー
- Issue #82 — Phase 1 (本 ADR を含む)
- `docs/tauri-purge-inventory.md` — Phase 1 で作成した正引き/逆引きインベントリ
