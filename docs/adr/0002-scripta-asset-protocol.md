# ADR-0002: ローカル画像配信に独自 privileged scheme `scripta-asset://` を使う

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

Markdown 本文には、ワークスペース内/外を問わずローカルの**絶対パス画像**が記述され得る（Unix の `/foo/bar.png`、Windows の `C:\Users\...\bar.png` / `C:/Users/.../bar.png`）。これを renderer（Chromium）で `<img>` として表示する経路が必要になる。

素朴な実装は `file://` URL を直接組み立てて CSP の `img-src` に `file:` を許可することだが、これには重大なセキュリティ問題がある:

- `img-src file:` を許可すると、**任意のローカルファイルを読み取れる経路**が開く。悪意あるノート（あるいは外部から取り込んだ Markdown）に `<img src="file:///etc/passwd">` 相当を仕込めば、ワークスペース外の任意ファイルへ Chromium が直接アクセスしてしまう。
- `file:` 経由のアクセスは Electron の `protocol.handle` ハンドラを経由しないため、本プロジェクトの path-guard（`isPathWithinAnyAllowedRoot`、ワークスペース root 配下のみ許可）を**強制できない**。

つまり「ローカル画像は表示したいが、表示のためにファイルアクセス境界を緩めたくない」という要求が衝突している。すべてのローカルファイルアクセスを必ず main 側の path-guard に通し、なおかつ CSP は最小許可に保ちたい。

選択肢としては次の 2 つが見えていた:

- `file://` を CSP `img-src` に直接許可する
- ローカル画像配信専用の独自スキームを `registerSchemesAsPrivileged` で登録し、そのスキームだけを CSP に許可する

## Decision

独自スキーム **`scripta-asset://localhost/<encoded-path>`** を導入し、これを唯一のローカル画像配信経路とする。`file:` は CSP `img-src` に許可しない。

### スキーム登録とアクセス制御

- `app.ready` より前（Electron の要件）に `protocol.registerSchemesAsPrivileged` で `scripta-asset` を `standard: true` / `secure: true` / `supportFetchAPI: true` / `stream: true` として登録する（`electron/main/index.ts` の `SCRIPTA_ASSET_SCHEME`）。
- CSP の `img-src` には `scripta-asset:` のみを足し、`file:` は加えない（`CSP_PROD` / `CSP_DEV` 双方）。
- 実体配信は `protocol.handle(SCRIPTA_ASSET_SCHEME, ...)` ハンドラが担い、ここで **必ず** `isPathWithinAnyAllowedRoot`（path-guard）を通す。ワークスペース外のパスは `403` で弾き、エラー本文にパスを含めない（拒否されたパスの存在情報が renderer の DevTools から漏れないようにするため）。`hostname` は `localhost` 固定でそれ以外は `400`。これにより、ローカルファイルアクセスは漏れなく main 側の境界チェックを経由する。

### renderer 側 API surface

- renderer からは preload が公開する `buildAssetUrl(path)` を呼ぶ（`src/lib/commands.ts` のラッパー → preload の `buildAssetUrl` → 純粋関数 `buildScriptaAssetUrl`）。
- URL の組立（`buildScriptaAssetUrl`）と分解（`urlPathnameToFsPath`）は `electron/main/index.ts` のハンドラと preload、および各種テスト mock で同一でなければならないため、**Electron / Node API に依存しない純粋関数**として `electron/preload/scripta-asset-url.ts` に切り出し、どこからでも import できるようにしている。

### URL 組立の安全性（`buildScriptaAssetUrl`）

任意のローカルパスを `scripta-asset://` URL に変換する際、`new URL()` で確実に・予測どおりにパースできることを保証する必要がある。次の正規化を行う:

- Windows の `\` を `/` に置換（バックスラッシュは URL pathname で legal でない）。
- leading `/` を付与（無いと drive letter 等が `localhost` 直後の authority に巻き込まれ、`scripta-asset://localhostC:/...` のように `Invalid URL` になる）。
- パスを `/` 区切りで分割し、各セグメントを `encodeURIComponent` で escape（`encodeURI` は `#` / `?` を escape せず、それらを含むパスが pathname / hash / search に分断されてしまう）。

逆操作 `urlPathnameToFsPath` は `decodeURIComponent` でパスへ戻し、Windows でのみ `/C:/Users/...` 形式の leading `/` を除去する（Node の path API が drive 付き絶対パスとして扱える形へ）。POSIX では `/C:/...` 自体が合法な絶対パスのため strip しない（strip すると path 検証で「絶対パスでない」と誤判定され 403 で弾かれる）。

### 代替案比較

| 案 | Pros | Cons |
|---|---|---|
| `file://` を `img-src` に直接許可 | 実装が最小。スキーム登録もハンドラも不要 | **任意ローカルファイル読み取りの経路になる**。`protocol.handle` を経由しないため path-guard を強制できず、ワークスペース外アクセスを弾けない。CSP を緩めることになる |
| **独自スキーム `scripta-asset://`（採用）** | アクセスが必ず `protocol.handle` → path-guard を経由し、ワークスペース外は 403。CSP は `scripta-asset:` のみ許可で `file:` を閉じたまま最小化できる | スキーム登録（`app.ready` 前）とハンドラの実装が必要。URL の組立/分解ロジックが必要 |

→ セキュリティ境界（path-guard の強制と CSP 最小化）を最優先し、**独自スキーム案を採用**する。

## Consequences

### 良い影響

- ローカルファイルアクセスが**漏れなく main 側 path-guard を経由**し、ワークスペース外パスは 403 で拒否される。
- CSP の `img-src` は `scripta-asset:` のみ許可で済み、`file:` を閉じたまま最小化できる。任意ローカルファイル読み取りの経路を塞げる。
- `localhost` host 固定・per-segment encode により、`new URL()` パースの挙動が予測可能で、`#` / `?` / 非 ASCII / 空白を含むパスでも壊れない。

### 注意すべき影響

- URL の**組立（`buildScriptaAssetUrl`）と分解（`urlPathnameToFsPath`）の 2 箇所、加えてテスト mock がロジックを複製する**構図になり、drift（実装乖離）のリスクがある。これを `electron/preload/scripta-asset-url.ts` の純粋関数として 1:1 共有し、preload / main / テストすべてが同じ実装を import することで緩和している（mock も同関数を呼ぶ／round-trip テストで原形復元を検証）。
- 特権スキームではホスト名は本来意味を持たないが、表記の一貫性を強制するため `localhost` 以外は 400 で弾いている。新たに別 host を使う拡張をする際はこの前提を見直すこと。

### 関連する将来の検討事項

- 現状 path-guard の allowed root は単一ワークスペース前提に近い。複数ワークスペース／複数 allowed root への拡張時は `isPathWithinAnyAllowedRoot` の承認管理（`approveWorkspacePath`）と本スキームのアクセス制御を併せて見直す。

## References

- Issue #84 — Phase 3（PR-3-1: `convertFileSrc` → `buildAssetUrl` rename、PR-3-5: 本 ADR）
- `electron/main/index.ts` — `SCRIPTA_ASSET_SCHEME` 登録・CSP・`protocol.handle` ハンドラ
- `electron/preload/scripta-asset-url.ts` — `buildScriptaAssetUrl` / `urlPathnameToFsPath` 純粋関数
- `electron/preload/index.ts` — preload が `buildAssetUrl` として公開
- `src/lib/commands.ts` — renderer 側ラッパー
- `electron/main/utils/path-guard.ts` — `isPathWithinAnyAllowedRoot`
- ADR-0000 — 設計判断を ADR に記録する（本 ADR の運用ルール元）
