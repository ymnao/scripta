# ADR-0004: SemVer 比較を `semver` npm パッケージに依存せず自前実装する

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

アップデートチェック (`electron/main/ipc/update.ts`) は、GitHub Releases API の latest release から取得した `tag_name` (例: `v1.2.3`) を、`v` 前置きを除いた SemVer としてアプリの現在バージョンと比較し、新しいリリースの有無 (`hasUpdate`) を判定する。

この用途で実際に必要な機能はごく狭い:

- **2 つの SemVer の大小比較** (`current` vs `latest` → `latest > current` か)
- **最小限のバリデーション** — 不正な `tag_name` / `currentVersion` を弾く

具体的には、`update.ts` は `semver-lite.ts` の以下 3 つしか使っていない:

- `parseSemver(v)` — `"x.y.z"` core + 任意の `-prerelease` をパースし、不正値は throw
- `compareSemver(a, b)` — SemVer 2.0.0 §11 の順序で `-1 / 0 / 1` を返す
- `stripVPrefix(v)` — `v` / `V` 前置きの除去

逆に **不要** な機能が多い:

- 範囲指定 (caret `^1.2.0` / tilde `~1.2.0` / range `>=1.0.0 <2.0.0`)
- coerce / clean / inc などの操作系 API
- ワイルドカード・部分バージョン (`1.x`, `1.2`) の補完

ここで「フル機能の `semver` npm パッケージを依存に加えるか」「必要最小サブセットを自前実装するか」という選択が必要になった。判断しなければ、本来 compare/parse の薄い機能で済むものに対し、main プロセス (Node.js 実行環境) のランタイム依存を 1 つ抱え込むことになる。

なお SemVer 仕様には自前実装で踏みやすいエッジケースがあり、これらは網羅する前提で検討する:

- numeric identifier (major/minor/patch) の **leading zero 禁止** — `"0"` は可、`"01"` / `"00"` は invalid (§2)
- build metadata (`+build`) は **比較に含めない** が、文字種・空要素のバリデーションは行う。numeric の leading zero は §10 で明示的に許容 (prerelease の §9 と非対称)
- prerelease なし > prerelease あり (§11)
- prerelease 内 numeric は数値比較、alpha は ASCII 辞書順、numeric < alpha (§11)
- `"1.0.0-"` のように hyphen 直後が空の prerelease は §9 違反

## Decision

フル機能の `semver` npm パッケージを依存に加えず、`electron/main/utils/semver-lite.ts` に **必要最小サブセットを Node stdlib のみで自前実装** する。

判断の根拠:

- **依存削減** — main プロセスのランタイム依存を増やさない。`semver-lite.ts` は外部 import ゼロ
- **attack surface の最小化** — アップデートチェックは外部 (GitHub) 由来の文字列を入力に取る経路であり、ここで動く依存は小さく監査可能な方が望ましい
- **必要なのは compare/parse の薄い機能のみ** — range / coerce 等を一切使わないため、フルパッケージの大半が死蔵コードになる
- **SemVer 仕様準拠のエッジケース** (leading-zero / prerelease / build metadata の扱い) は自前実装 + ユニットテストでカバーできる範囲

| 案 | Pros | Cons |
|---|---|---|
| `semver` npm パッケージ採用 | SemVer 2.0.0 を網羅。range/coerce など将来拡張に強い。仕様準拠はライブラリ側が担保 | 用途 (compare/parse のみ) に対し過剰。ランタイム依存 + transitive dep が増える。外部入力経路の attack surface 増。死蔵 API が大半 |
| **`semver-lite.ts` に最小サブセットを自前実装** | **ゼロ依存・小さく監査可能。必要な compare/parse/strip だけ。外部入力経路を stdlib に閉じられる** | **SemVer 仕様の網羅性は自前テストに依存。range/coerce など複雑な要求が来たら作り込みコスト** |

→ 用途が「2 つの SemVer の大小比較 + 最小バリデーション」に限定され、当面拡張の予定もないため、後者 (**自前 lite 実装**) を採用する。

## Consequences

### 良い影響

- main プロセスがゼロ依存で SemVer 比較を行え、`semver-lite.ts` 単体で監査が完結する
- アップデートチェックという外部入力経路の実装が stdlib + 自前 regex に閉じ、attack surface が小さい
- 実装が 120 行程度に収まり、SemVer 仕様のどのケースをどう扱っているかがコード上で追える

### 注意すべき影響

- SemVer 仕様の網羅性は **自前ユニットテストに依存** する。leading-zero / build metadata / prerelease 順序などのエッジケースは、テストが薄いと退行に気づけない
- `compareSemver` / `parseSemver` は SemVer 2.0.0 のうち本用途に必要な範囲のみ実装しており、**フル仕様を保証するものではない**。汎用 SemVer ライブラリとして他用途に転用しない
- prerelease の複雑な比較 (多段識別子の数値/英字混在など) が継続的に必要になった場合、自前テストの維持コストが上がる

### 関連する将来の検討事項

- 範囲指定 (caret `^` / tilde `~` / range) や coerce が必要になった場合は、自前実装を拡張せず `semver` パッケージ採用を再検討する (lite 実装にこれらを足すと「最小サブセット」の利点が失われ、独自実装の網羅性リスクだけが残るため)
- electron-updater (Stage 6) へ移行した場合、バージョン比較がそのエコシステム側に移る可能性があり、その時点で `semver-lite.ts` の要否を見直す

## References

- Issue #84 — Phase 3 PR-3-5 (アップデートチェックの SemVer 比較移植)
- `electron/main/utils/semver-lite.ts` — 本 ADR で採用した自前実装
- `electron/main/ipc/update.ts` — `parseSemver` / `compareSemver` / `stripVPrefix` の利用箇所
- ADR-0000 — 設計判断を ADR に記録する方針
- Semantic Versioning 2.0.0 (<https://semver.org/>) — §2 / §9 / §10 / §11
