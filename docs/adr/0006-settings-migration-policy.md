# ADR-0006: 既存配布アプリの userData / settings.json 互換を当面維持する

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

Electron は `app.getPath("userData")` を `app.getName()`（packaged では productName）ベースで解決する。本リポジトリの `package.json:name` は `scripta-next` だが、既存の配布済みアプリ（productName = `scripta`、`~/Library/Application Support/scripta` 等）のユーザー設定（`workspacePath` / `themePreference` / window state）を新版でも継続利用したい。

`electron/main/ipc/settings.ts` の `settings.json` は既存アプリと同一形式を維持しており（`getValue` の None / Some(Null) 非区別仕様も旧版に合わせている）、format 面でも互換が取れている状態にある。

既存アプリ（旧 Tauri 版）は新版への移行が完了するまで並走稼働する前提（`CLAUDE.md`「移行完了まで稼働継続」）。この移行期間中、既存ユーザーに設定の再設定を強いるか、シームレスに引き継ぐかの判断が必要になる。

この判断は `docs/tauri-purge-inventory.md` §3 で選択肢比較と判定が既に行われており、本 ADR はそれを恒久記録へ昇格させるものである（インベントリ本体は Phase 5 完了時に dead artifact 化しても ADR は残る）。

現状コードでは `electron/main/index.ts` で以下を実行している:

```ts
if (app.isPackaged) {
  app.setName("scripta");
}
```

`app.isPackaged` 時のみ上書きすることで、pnpm dev は新版独自の userData（`scripta-next`）を使い、開発中の操作が本番設定を汚染しない隔離になっている。

## Decision

`docs/tauri-purge-inventory.md` §3 の **案 A（互換維持）を採用**する。`app.isPackaged` 時のみ `app.setName("scripta")` で userData ディレクトリ名を `scripta` に固定し、既存アプリのユーザー設定を引き継ぐ。pnpm dev では `scripta-next` 名のままとし、開発時の sidebar / workspacePath / window state 操作が本番アプリの設定を汚染するのを防ぐ。

| 案 | 説明 | 影響 |
|---|---|---|
| **A. 互換維持（採用）** | 現状維持。`setName("scripta")` を残し、既存アプリユーザーの設定（`workspacePath` / `themePreference` / window state 等）を継続利用 | 旧アプリが同 userData に同時アクセス中は競合リスク（現実的には同時起動禁止扱い）。`docs/parity-checklist.md:192` と整合 |
| B. 撤去 | `setName` 削除。新版は `scripta-next` 名で fresh userData。手動移行 doc を提供 | code は simpler だが既存ユーザーが workspacePath 等を再設定必要。旧アプリが並走稼働する移行期間は user-hostile |

案 A を採用した根拠:

- 既存アプリ（旧 Tauri 版）が並走稼働する移行期間中、設定の再設定を強いるのは user-hostile である
- `setName` の 1 行で互換性を維持できるコストの低さ
- 撤去はリポジトリ / productName リネーム（#28）と同タイミング（リポジトリ名・productName を `scripta` に正規化する流れで、`scripta-next` → `scripta` の userData 移行を明示）が自然である

## Consequences

### 良い影響

- 既存配布アプリのユーザーが、設定（`workspacePath` / `themePreference` / window state）を再設定することなくシームレスに新版へ移行できる
- `settings.json` の format を既存アプリと同一に保つことで、移行期間中どちらのアプリで起動しても設定が読める

### 注意すべき影響

- 既存アプリと新版が同一 userData（`~/Library/Application Support/scripta` 等）に同時アクセスすると競合リスクがある。実質的に両者の同時起動は禁止扱いとする
- packaged のみで `setName("scripta")` を行うため、pnpm dev（`scripta-next`）と packaged（`scripta`）で参照する userData が異なる。開発時に再現できない本番設定起因の挙動があり得る点に留意する

### 関連する将来の検討事項

- 撤去（案 B 相当）はリポジトリ / productName リネーム（#28）と同タイミングで、`scripta-next` → `scripta` の userData 移行を明示するのが自然である
- その際は本 ADR を **supersede する新 ADR を起こす**（本 ADR は Deprecated にし、Status 行と `Superseded by` 行のみ更新。本文は判断当時の文脈を保つため凍結する）

## References

- Issue #84 — Phase 3 PR-3-5
- Issue #28 — リポジトリ / productName リネーム
- `docs/tauri-purge-inventory.md` §3 — 選択肢比較と判定（本 ADR の昇格元）
- `electron/main/index.ts` — `app.isPackaged` 時の `app.setName("scripta")`
- `electron/main/ipc/settings.ts` — `settings.json` の永続化・互換形式
- `docs/parity-checklist.md:192` — 互換維持と整合する記述
- ADR-0000 — ADR 運用ルール（supersede 時の凍結方針）
