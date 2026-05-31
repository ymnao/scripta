# ADR-0003: IPC fs エラーを message 文字列契約として維持する

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

main プロセスの IPC ハンドラ (`electron/main/ipc/` 以下) は、ファイル操作・Git 操作などの失敗時に `Error` を reject する。この `Error` は **構造化されておらず、message 文字列のみ** を情報として持つ。

- main 側 (`electron/main/utils/fs-errors.ts`) は `Already exists: <path>` / `Source not found: <path>` / `Target already exists: <path>` / `Not found: <path>` といった **特定の英語 message** を生成する。これらは旧 Tauri 版と同じ message 形式を意図的に踏襲している。
- renderer 側 (`src/lib/errors.ts`) は受け取った message を **正規表現でパース** して分類する:
  - `translateError()` — message を日本語のユーザー向け文言へ翻訳 (`/^Already exists:/` → 「同名のファイルが既に存在します」等)
  - `isTransientError()` — `NON_TRANSIENT` パターン (`/^Permission denied:/`, `/\bENOENT\b/`, `/\(os error 13\)/` 等) に該当しないものを transient とみなし、`withRetry` のリトライ判定に使う
  - `isNetworkError()` — `could not resolve host` / `connection refused` 等のネットワーク系パターンを判定

つまり「main が生成する英語 message 文字列」が main↔renderer 間の **事実上の契約** になっている。errno コード (`ENOENT` 等) や Rust 由来の `(os error N)` 表現、Git の英語メッセージ (`authentication failed` 等) も、すべて message 文字列の中に埋め込まれた状態で renderer の regex に渡る。

この設計には以下の課題がある:

- エラーの種別 (code / kind) が **型で表現されていない**。renderer は文字列の中身に依存しており、契約が型システムで保証されない。
- 文言を 1 文字変えると分類が静かに壊れる (regex の取りこぼし)。
- Git エラーの英語固定は `LC_ALL=C` で locale を固定する前提に依存している。

一方で、この「文字列 message を契約とする」設計は Tauri → Electron 移行時の互換性のために採用されたものであり、移行直後に作り替えるのはリスクが高い。

## Decision

**現時点では message 文字列形式を契約として維持する。** main が特定の英語 message を生成し、renderer が正規表現で transient / permanent / network 等に分類する現行方式を凍結する。

| 案 | Pros | Cons |
|---|---|---|
| **A. message 文字列契約を維持 (採用)** | 移行リスク最小 / 旧 Tauri 版・既存テストとの挙動が完全一致 / `LC_ALL=C` による Git エラー英語固定の前提と一貫 | regex parse が脆い / 型で保証されない / i18n と相性が悪い |
| B. いますぐ structured error 化 | 型安全 / regex 脱却 | 移行直後に main↔renderer 契約を作り替える大改修 / 既存挙動の凍結 (safety net) が崩れる / 回帰リスク大 |

採用理由:

- **移行リスク最小** — Tauri purge / Electron 移行の最中に IPC エラー契約を作り替えると、回帰の温床になる。まず既存挙動を凍結する。
- **既存テストとの整合** — renderer 側の regex 分類とそれに紐づくテストが現行 message 形式を前提にしている。形式維持により安全網を保てる。
- **locale 固定前提との一貫性** — Git エラーは `LC_ALL=C` で英語固定にしており、renderer の英語 regex 前提と整合する。message 文字列契約はこの前提の延長線上にある。

**ただし、structured error (error code を型付きで IPC 越しに渡す方式) への移行を Phase 5 (Issue #85) で行う計画** を本 ADR に明記する。Phase 5 では main 側が `{ code, message, ... }` のような構造化エラーを返し、renderer は code に基づいて型安全に分類する形へ刷新する。

## Consequences

### 良い影響

- Tauri → Electron 移行が安全に進む。IPC エラーの契約面で回帰を起こさない。
- 旧 Tauri 版と同一の message 形式・renderer 分類挙動が凍結され、移行前後の差分を検証しやすい。
- `fs-errors.ts` のファクトリで生文字列を一元管理しているため、message 形式のタイポ事故を防げる。

### 注意すべき影響

- regex parse は **脆い**。message 文言を変更すると renderer の分類が静かに壊れる。`fs-errors.ts` の message を変える際は必ず `src/lib/errors.ts` の対応パターンを同時に見直す必要がある。
- エラー種別が型で表現されないため、main↔renderer の契約はコンパイラではなくテストとレビューで担保するしかない。
- 英語 message を前提とするため **i18n と相性が悪い**。Git エラーは `LC_ALL=C` での locale 固定に依存しており、この前提が崩れると分類が壊れる。

### 関連する将来の検討事項

- **Phase 5 (Issue #85) で structured error 化** する。error code を型付きで IPC 越しに渡し、renderer は code ベースで分類する方式へ移行する。
- structured error 化を実施する際は、本 ADR を **supersede する新 ADR を起こす** (本 ADR は Status を `Deprecated` に更新し `Superseded by` を併記、本文は凍結)。

## References

- Issue #84 — Phase 3 PR-3-5 (本 ADR の作成契機)
- Issue #85 — Phase 5 (structured error 化計画)
- `electron/main/utils/fs-errors.ts` — main 側が生成する fs エラー message のファクトリ・定数
- `src/lib/errors.ts` — renderer 側の regex 分類 (`translateError` / `isTransientError` / `isNetworkError`)
- ADR-0000 — 設計判断を ADR に記録する (本 ADR の運用ルール母体)
