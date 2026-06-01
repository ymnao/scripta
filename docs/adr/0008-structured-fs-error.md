# ADR-0008: IPC エラーを structured error (discriminated union) として渡す

- **Status**: Accepted
- **Date**: 2026-06-01
- **Supersedes**: [ADR-0003](0003-fs-error-message-format.md)

## Context

[ADR-0003](0003-fs-error-message-format.md) では、Electron 移行直後の回帰リスクを避けるため、IPC エラーを「main が生成する英語 message 文字列を renderer が正規表現でパースして分類する」契約として**意図的に凍結**していた。これは旧バックエンド（Tauri）の `Result<T, String>` パターン由来の design smell であり、ADR-0003 自身が Phase 5（Issue #85）での structured error 化を将来課題として明記していた。

凍結された方式の課題（ADR-0003 で既述）:

- エラー種別が型で表現されず、renderer は message 文字列の中身に依存する。
- message 文言を 1 文字変えると renderer の分類が静かに壊れる。
- `(os error N)` 表現（旧バックエンドの errno 表現）を含む regex が `src/lib/errors.ts` に残存していた。

Phase 1〜3・6 の完了でバックエンドが Electron + 純 JS に揃い、移行直後の凍結を解く条件が整った。本 ADR で structured error 化を実施する。

### Electron IPC のエラー伝播制約（設計の前提）

Electron の `ipcMain.handle` ハンドラが reject すると、renderer の `ipcRenderer.invoke` には **`error.message`（と stack）しか渡らず、`error.code` / `error.kind` 等のカスタムプロパティは IPC を越えると失われる**。したがって構造化エラーをそのまま投げても renderer 側では復元できない。構造を運ぶには message にエンコードして渡し、preload で復元する層が必須になる。

## Decision

**IPC エラーを `ErrorKind`（discriminated union）でタグ付けされた structured error として渡す。** 分類は main 側で 1 度だけ行い、renderer は `error.kind` で型安全に分岐する。`src/lib/errors.ts` から正規表現による message パースを全廃する。

scope はユーザー判断により **fs だけでなく git / network を含む全 IPC エラー**とした（受け入れ基準「errors.ts から regex 全除去」を額面どおり満たすため）。

### 構成

- **`src/types/errors.ts`（共有）** — `ErrorKind` union、`StructuredErrorData { kind, message, code?, path? }`、ワイヤ codec（`encodeIpcError` / `decodeIpcError`、sentinel `SCRIPTA_STRUCTURED_ERR:`）、`getErrorKind`。main / preload / renderer の全プロセスから import する純粋モジュール。
- **`electron/main/utils/structured-error.ts`（main）** — `StructuredError` クラス、errno → kind の `classifyErrno`、git stderr → kind の `classifyGitError`、`serializeIpcError`、`ipcMain.handle` のラッパー `handle()`。**旧 renderer 側 regex の分類ロジックは、エラーを生成する main 側へ移設**した（生成側で 1 度だけ分類するのが自然な置き場所）。
- **fs ハンドラ** — `fs-errors.ts` の `FsError.*` ファクトリが `StructuredError`（`ALREADY_EXISTS` / `SOURCE_NOT_FOUND` 等の意味的 kind）を返す。生 errno（ENOENT 等）は `handle()` ラッパーが `classifyErrno` で分類する。`path-guard` は `INVALID_PATH` / `PATH_OUTSIDE_WORKSPACE` を投げる。
- **git ハンドラ** — `gitError(stderr)` が `classifyGitError` で `GIT_AUTH` / `GIT_CONFLICT` / `GIT_NOTHING_TO_COMMIT` / `NETWORK` 等に分類して投げる。
- **preload（`ipc-error-decode.ts`）** — `invoke()` が全 IPC 呼び出しをラップし、reject 時に `decodeIpcError` で sentinel を復元して `kind` / `code` / `path` を持つ Error を renderer へ投げる。
- **renderer（`errors.ts`）** — `translateError` = `kind → 日本語メッセージ`、`isTransientError` = `NON_TRANSIENT_KINDS` の否定、`isNetworkError` = `NETWORK_KINDS` 判定。regex は無い。

### ワイヤ形式

main は `error.message` を `SCRIPTA_STRUCTURED_ERR:` + `JSON.stringify({kind,message,code,path})` に符号化する。preload は sentinel を `indexOf` で探すため、Electron が `Error invoking remote method '<channel>': ...` の prefix を付けて message を wrap しても復元できる。

### kind カタログの設計判断

Issue #85 本文の例（`ENOENT|EACCES|EISDIR|ENOTDIR|PATH_OUTSIDE_WORKSPACE|TRANSIENT|UNKNOWN`）は最小例であり、現行の `translateError` が区別する約 20 種の日本語メッセージを保てない。**メッセージ粒度と挙動を 1:1 で保つことを優先**し、errno 系（`ENOENT` 等）+ 意味的（`ALREADY_EXISTS` 等）+ git/network（`GIT_CONFLICT` 等）を網羅する豊富な union を採用した。

`TRANSIENT` は**独立した kind にせず**、`isTransientError` が `NON_TRANSIENT_KINDS`（再試行しても回復しない種別の集合）の否定として**導出**する。これにより「一時的だが具体的（EAGAIN/EBUSY）」なエラーの message 粒度を失わない。`(os error N)` パターンは旧バックエンド固有の表現で、Node は errno コードを返すため**死蔵として廃止**した。

### 代替案

| 案 | Pros | Cons |
|---|---|---|
| **A. message に JSON を符号化し preload で復元（採用）** | throw ベースの既存契約を維持 / 呼び出し側の戻り型を変えない / 集約層 2 箇所（main `handle` / preload `invoke`）で済む | sentinel 文字列の規約が必要 |
| B. Result 型エンベロープを返す（throw しない） | 明示的 | 全ハンドラの戻り型と全呼び出し側を改修 / 大規模 |
| C. 各ハンドラで個別に message を組み立てる | 単純 | DRY でない / 分類ロジックが散らばる |

## Consequences

### 良い影響

- エラー種別が型（`ErrorKind`）で表現され、renderer は文字列の中身に依存しない。`translateError` 等は exhaustive な `Record<ErrorKind, ...>` で網羅性がコンパイラ保証される。
- message 文言の変更が分類を壊さない（kind が契約）。
- 分類ロジックが生成側（main）に集約され、`LC_ALL=C` 前提の git stderr 分類も main 側 1 箇所になった。

### 注意すべき影響

- main↔preload 間に sentinel 符号化のワイヤ規約が増えた（`src/types/errors.ts` の codec が単一の真実源）。
- `handle()` を経由しないハンドラ（settings / window / dialog 等）の生エラーは `UNKNOWN` kind に落ちる。`translateError` の既定（「予期しないエラー…詳細: …」）で表示され、挙動上問題ないが、新規ハンドラで意味的分類が要る場合は `StructuredError` を投げるか `handle()` を使う。
- renderer が `setErrorMessage` に保存するのは（kind を保てない生文字列ではなく）**翻訳済み表示メッセージ**へ変更した（保存経路で kind が失われないよう、live error のうちに `translateError` する）。

## References

- Issue #85 — Phase 5（structured error 化）
- [ADR-0003](0003-fs-error-message-format.md) — 本 ADR が supersede する「message 文字列契約の凍結」
- [ADR-0007](0007-commands-ipc-client-layer.md) — commands.ts を IPC client + retry layer と再定義（`withRetry` が `isTransientError` を使う）
- `src/types/errors.ts` / `electron/main/utils/structured-error.ts` / `electron/preload/ipc-error-decode.ts` / `src/lib/errors.ts`
