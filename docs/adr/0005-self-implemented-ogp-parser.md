# ADR-0005: OGP パーサを自前実装する（HTML パーサライブラリを使わない）

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

リンクカード機能では、外部 URL の OGP メタデータ（`og:title` / `og:description` / `og:image` / `og:site_name`、フォールバックとして `<title>`）を取得・抽出する。この処理は main プロセスで外部 HTTP レスポンスという信頼境界の外側のデータを扱い、SSRF 防御（`electron/main/utils/ssrf-guard.ts` の `pinSafeLookup`）と組み合わせて動く（取得部は `electron/main/ipc/ogp.ts`、抽出部は `electron/main/utils/ogp-parser.ts`）。

HTML から OGP を抽出する手段には複数の選択肢がある:

- フル DOM パーサ（`cheerio` / `jsdom` / `parse5` 等）を依存に加え、CSS セレクタ / DOM API で `<meta>` を抽出する
- 正規表現でタグをマッチする
- `<` 区切りの線形 scan で `<meta>` / `<title>` だけを拾う軽量パーサを自前実装する

ただし、実際に必要なのは限定された数個の `<meta property="og:*">` タグと `<title>` からの抽出のみであり、汎用 DOM ツリーや任意のセレクタクエリは不要である。また main プロセスで信頼境界をまたぐコードであるため、依存（=攻撃対象面）はできるだけ小さく、監査しやすい状態に保ちたい。

## Decision

HTML パーサライブラリを依存に加えず、`electron/main/utils/ogp-parser.ts` に**線形 scan ベースの軽量パーサを自前実装する**。

実装の要点（実コードの挙動）:

- `parseOgp(html, url)` は HTML を `html.split("<")` で 1 度だけ分割し、各セグメントについて先頭が `meta`（直後がタグ名終端文字 = 空白 / `/` / `>`）であるものだけを処理する。`<metadata ...>` のような別タグを誤って拾わない。
- 各 meta セグメントは小さな状態機械 `iterateAttributes` で属性 (name, value) を 1 度だけ走査する。属性名の境界（タグ名直後 / 空白 / `/`）を検査することで、`data-content="..."` を `content="..."` と取り違えない。属性値はクオート有無の両方を扱う。
- `og:title` / `og:description` / `og:image` / `og:site_name` の 4 プロパティを 1 パスで同時に抽出する（プロパティごとに scan を繰り返さない）。
- **重複した `og:*` タグが現れた場合は最初の出現を採用する**（`found[targetKey] !== undefined` のときは以降を無視する。旧 Rust `extract_og_meta` と同一 semantics）。
- `<title>` フォールバックは `findTitleTagOpen` で `<title` の直後がタグ名終端文字である開始位置のみをマッチし、`<titlebar>` のような別タグを誤マッチしない。`og:title` が取れなかった場合のみ `<title>` を使う。
- HTML エンティティのデコード（`decodeHtmlEntities`）は **`&amp;` を最後にデコードする**。先に `&amp;` を `&` に戻すと `&amp;lt;` → `&lt;` → `<` のような二重デコードが起こるため、`&lt;` / `&gt;` / `&quot;` / `&#39;` / `&#x27;` / `&#x2F;` を先に処理してから `&amp;` を処理する（旧 Rust 版と同一順序）。

### 採用理由

- **依存削減＝attack surface 最小化**: main プロセスで信頼境界をまたぐ処理に、サイズの大きい DOM パーサを追加せずに済む。
- **必要機能が限定的**: 抽出対象は 4 つの `og:*` と `<title>` のみで、汎用 DOM パースは過剰。
- **線形 scan は堅牢**: 旧 Tauri 版（Rust）の線形 scan が本番運用で実績があり、属性順 / 改行混入 / 全角混入に対して壊れにくい。正規表現はこれらで簡単に壊れる。1:1 移植なので port のリスクも最小。
- **挙動を明示的に制御できる**: 「重複 `og:*` は最初の出現を採用」「`&amp;` の二重デコード回避」のような細部の semantics を自分のコードで固定できる。
- **インストール時制約の回避**: cheerio 等の導入は `denyOnly` sandbox 制約により、テストフィクスチャ（`.idea` / `.gitmodules` 等）の作成が阻まれる問題もあった。

### 代替案比較

| 案 | Pros | Cons |
|---|---|---|
| cheerio / jsdom 等の DOM パーサ採用 | 任意の DOM 構造から堅牢に抽出できる / 不正な HTML への正規化が組み込み / セレクタが宣言的 | 依存サイズが大きく attack surface が増える（信頼境界処理で不利）/ 必要機能（4 タグ抽出）に対して過剰 / sandbox 制約下のインストールで問題 |
| **自前の線形 scan パーサ（採用）** | **ゼロ依存で attack surface 最小 / コードが小さく監査容易 / 重複採用規則・エンティティデコード等の挙動を明示制御 / 旧 Rust の本番実績を 1:1 移植** | **不正な HTML への頑健性が自前テストに依存 / 複雑な DOM 構造からの抽出には不向き** |

最終的に**自前の線形 scan パーサ**を採用する。

## Consequences

### 良い影響

- ゼロ依存で OGP 抽出が完結し、SSRF 文脈で信頼できる小さなコードに保てる。
- パーサ実装が小さく、監査・レビューが容易。
- 重複 `og:*` の採用規則や HTML エンティティの二重デコード回避といった細部の挙動を、コードとテストで明示的に固定できる。
- 旧 Tauri 版と同一 semantics を維持しているため、移行前後で OGP 抽出結果が変わらない。

### 注意すべき影響

- 不正・破損した HTML に対する頑健性は、外部ライブラリの正規化に頼らず**自前テスト**に依存する。エッジケース（不完全タグ / 異常な属性 / エンティティ）はテストでカバーし続ける必要がある。
- 複雑な DOM 構造（ネスト / スクリプト埋め込み等）からの抽出には向かない。あくまで `<meta>` / `<title>` の表層 scan に限定される。

### 関連する将来の検討事項

- より高度な抽出要件（任意セレクタでの抽出、構造化データ JSON-LD のパース等）が出た場合は、その時点で DOM パーサ採用を再検討する。本 ADR を supersede する新規 ADR を起こす。

## References

- Issue #84（Phase 3 PR-3-5）
- `electron/main/utils/ogp-parser.ts` — 自前 OGP パーサ実装
- `electron/main/ipc/ogp.ts` — OGP 取得の利用箇所（SSRF 防御と組み合わせ）
- `electron/main/utils/ssrf-guard.ts` — SSRF 防御（信頼境界の文脈）
- ADR-0000 — 設計判断を ADR に記録する方針
