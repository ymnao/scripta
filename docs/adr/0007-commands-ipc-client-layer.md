# ADR-0007: `commands.ts` を IPC client / retry layer として維持する（inline しない）

- **Status**: Accepted
- **Date**: 2026-06-01

## Context

`src/lib/commands.ts` は renderer から main への IPC 呼び出しを集約する層で、各 export 関数は preload の contextBridge が公開する `window.api.*` を呼ぶ。一部の関数（`readFile` / `writeFile` / `listDirectory` / `renameEntry` / `deleteEntry` / `searchFiles` / `searchFilenames` / `scanUnresolvedWikilinks`）は `withRetry` で transient error 時に再試行するが、残り約 30 関数は `window.api.*` への 1:1 forward（retry なし）である。

この層は旧 Tauri 版の `invoke("cmd_name", args)` ラッパーの後継として作られた。Tauri では typed な API 境界が無く、文字列ベースの `invoke` を型安全にまとめる目的で `commands.ts` に実益があった。Electron では preload の `window.api` 自体が typed な境界であるため、「retry なしの 1:1 forward は `window.api` と重複する構造的レガシーではないか」という疑問が生じる（`docs/tauri-purge-inventory.md` の B 分類）。

Issue #84（Phase 3）の PR-3-2 は当初、この疑問への対応として **「retry なし関数を呼び出し元から `window.api.*` 直呼びへ inline し、`commands.ts` を retry 層のみに縮小する」** 案を文言として挙げていた。一方:

- `CLAUDE.md` は「IPC 経由のコマンドは `src/lib/commands.ts` に薄いラッパーを集約する」「呼び出し元は `commands.ts` を呼ぶだけにする」と facade 方針を明示している。
- 同 Phase の PR-3-3 は逆に `settings:*`（retry なし）を `store.ts` 直呼びから `commands.ts` 経由へ寄せ、facade を**完全化**する方向である。

つまり PR-3-2（facade 縮小）と PR-3-3（facade 拡大）が逆方向で、`CLAUDE.md` とも衝突していた。この設計矛盾の解消方針を決める必要があった。

## Decision

`commands.ts` を **renderer 側の IPC client + retry layer として維持し、retry なし関数の `window.api.*` 直呼びへの inline は行わない**。retry なし関数は引き続き typed な 1:1 forward として `commands.ts` に残す。

具体的には:

- `commands.ts` の役割を file-level JSDoc で「IPC client + retry layer」と再定義し、retry あり / retry なしの分類と各々の根拠を明記する（PR-3-2）。
- `settings:*` も `commands.ts` 経由に統一し、facade を完全化する（PR-3-3）。これにより renderer から `window.api.*` を直呼びする箇所は無くなる。
- 検討対象だった inline 案は採用しない。

| 案 | 説明 | 影響 |
|---|---|---|
| **A. facade 維持 + 再定義（採用）** | retry なし forward を残し、JSDoc で層を「IPC client + retry layer」と再定義。`settings:*` も経由化 | `CLAUDE.md` と整合。renderer が preload の形状に直結しない。diff 小・test churn ほぼ無し。pass-through の冗長性は層の存在理由を明文化して許容 |
| B. issue 文言どおり inline | retry なし約 30 関数を呼び出し元 約 25 ファイルへ `window.api.*` 直呼びで展開 | renderer 全体に `window.api.*` が散らばり transport と直結。将来 IPC 横断の関心事を足すたび全 call site を再改修。PR-3-3 が逆方向で実質撤回。diff 大・test churn 大 |

案 A を採用した根拠:

- **transport との疎結合**: `window.api`（preload の形状）を renderer 全体に撒くと UI が transport に直結し、retry / logging / error 変換等の IPC 横断の関心事を後から足す際に call site を全面改修する必要が出る。client 層を 1 つ保つことでこの chokepoint を維持できる。
- **PR-3-2 / PR-3-3 の矛盾を整合的に解消**: 両者を「完全で一貫した facade を作る」同一方向に揃えられるのは A だけである。
- **「Tauri レガシー」の本体はラッパーの存在ではなく invoke ラッパーという暗黙の枠組み**であり、JSDoc での再定義（+ 本 ADR）で解消できる。`window.api` 呼び出しに Tauri keyword は無く、legacy-residue CI ガード（v0.2.0 publish 後に撤去済み）でも green であった。
- `CLAUDE.md`（checked-in のアーキテクチャ契約）と整合し、pre-release のリスクが最小。

案 B が挙げる正当な批判（retry なし forward は `window.api` と重複する noise）は、**層の存在理由を JSDoc と本 ADR で明文化すること**で対処し、`window.api` を renderer に散らす方向は採らない。

## Consequences

### 良い影響

- renderer の各モジュールは `window.api`（preload transport）の形状に直接依存せず、IPC 呼び出し面が `commands.ts` に局所化される。
- IPC 横断の関心事（retry、将来の logging / error 変換）を `commands.ts` の 1 箇所で差し込める。
- `settings:*` も含め renderer から `window.api.*` を直呼びする箇所が無くなり、監査の索引が `commands.ts` の 1 箇所に集約される（従来は `commands.ts` + `store.ts` の 2 箇所）。

### 注意すべき影響

- retry なし関数は `window.api.*` のシグネチャを 1:1 で複製した forward であり、新しい IPC を追加するたび `commands.ts` にラッパーを 1 つ足す手間が残る。これは transport 疎結合のための許容コストと位置づける。

### 関連する将来の検討事項

- IPC 横断の関心事（error 変換の集約等）を足す場合は、各 call site ではなく本層に実装する。
- 本 ADR は issue #84 PR-3-2 の当初文言（inline 案）から逸脱した判断の恒久記録である。今後 inline 方針へ再転換する場合は本 ADR を supersede する新 ADR を起こす（本 ADR は Deprecated にし、本文は判断当時の文脈を保つため凍結する）。

## References

- Issue #84 — Phase 3 PR-3-2 / PR-3-3
- `src/lib/commands.ts` — file-level JSDoc で層を再定義
- `src/lib/store.ts` — `settings:*` を `commands.ts` 経由へ統一（PR-3-3）
- `docs/parity-checklist.md` — `settings:*` の経由方針の記述
- `docs/tauri-purge-inventory.md` — B 分類（構造的レガシー）の判断
- `CLAUDE.md` — IPC ラッパーを `commands.ts` に集約する方針
- ADR-0000 — ADR 運用ルール（supersede 時の凍結方針）
