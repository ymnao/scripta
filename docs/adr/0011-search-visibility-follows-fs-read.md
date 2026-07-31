# ADR-0011: 検索結果の可視範囲を fs:read の認可境界に揃える（workspace 外を指す symlink を結果から落とす）

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

`electron/main/ipc/search.ts` の scan（ワークスペース横断検索 / unresolved-wikilink scan / backlink scan が共有する `processMdFilesParallel`）は、#399 以来「**認可の境界は index / L2 に載せないことであって、検索結果に出さないことではない**」という契約で実装されていた。その帰結として、workspace 内に張られた `.md` symlink の解決先が workspace 外でも、その**内容は検索結果に出ていた**。

この境界は #399 Finding 2 → #406 → #413 → #416 と 4 回のレビューで再確認され、#416 Finding 1 の PR に対する codex-review security が MEDIUM / confidence 98 で再度指摘した（「O_NOFOLLOW で symlink を検出しても plain read にフォールバックするため、workspace 内の symlink 経由で任意の読み取り可能な Markdown を検索処理へ取り込める」）。指摘は本 PR で変えた挙動ではなく既存契約についてのものだったため、判断を [#434](https://github.com/ymnao/scripta/issues/434) に切り出した。

維持側の根拠は 2 つあった。

1. **正当なユースケースを壊さない** — ユーザーが意図的に外部 note を symlink で workspace に持ち込むケース
2. **コストを増やさない** — 「解決先が workspace 内なら出す」を実装するには scan の全 file に realpath を払う必要があり、それは #413 Finding 1 で意図的に削ったコストの復活になる

#434 の調査で **1 が事実として成立していない**ことが分かった。

- `assertPathAllowed`（`electron/main/utils/path-guard.ts`）は `realpathBestEffort` で symlink を完全解決してから workspace root 内包を判定し、解決先が外なら `PATH_OUTSIDE_WORKSPACE` を throw する
- `fs:read`（`readFileImpl`）はこのガードを通る。renderer は検索結果クリックも FileTree クリックも `AppLayout` の `handleFileSelect` → `openTab` → `readFile` に落とす
- したがって **workspace 外を指す symlink note は「検索結果に本文が出るのに、クリックすると開けない」**状態だった。閲覧も編集もできない以上、そこに守るべきユースケースは無い
- 一方 **in-root alias（解決先が workspace 内）は fs:read で開ける**ので、こちらは結果に出るべきユースケースが実在する

2 についても、#416 Finding 1 で L2 admission 用の read が既に `readFileUtf8NoFollow`（`O_NOFOLLOW` open + 同一 fd read）になっていたことで前提が変わっていた。**O_NOFOLLOW open の失敗が「この file は末端 symlink である」を追加 syscall なしで教える**ため、realpath を払う対象を「実際に symlink だった file」だけに絞れる。

## Decision

**検索結果の可視範囲を fs:read の認可境界に揃える。** 不変条件を

> **本文 scan の結果に出る file 集合 = fs:read で開ける file 集合**

と定め、`processMdFilesParallel` の read を次の 3 分岐に統一した。

**適用範囲は `processMdFilesParallel` を通る本文 scan 系 IPC**（`search:files` / unresolved-wikilink scan / backlink scan）に限る。file を読まない経路 — コマンドパレットのファイル名検索（SR-4、`searchFilenamesImpl`）と wikilink の解決先 stem 集合 — は file list を名前で filter するだけで realpath を払わないため、workspace 外を指す symlink も従来どおり候補に残る（開こうとすると fs:read が拒否する）。これらに同じ境界を効かせるには file list 構築時に全 entry の realpath を払う必要があり、本 ADR が避けたコストそのものになるため対象外とする。

1. **ゲート評価済み ∧ indexable** — 従来どおり `readFileUtf8NoFollow`。失敗（= 認可後に末端を swap された）は skip（#412）
2. **ゲート評価済み ∧ 非 indexable** — ゲートが既に realpath 済みなので追加 syscall なしで判別できる。`resolveInsideRoot` が null（workspace 外 / 解決不能）なら **結果からも落とす**、非 null なら in-root alias として解決先から読んで結果に出す
3. **ゲート未評価**（index 未提供 / index 無効 / 既に valid）— まず `readFileUtf8NoFollow`。失敗して初めて `resolveInsideRoot` を払い、2 と同じ判定に倒す

| 案 | Pros | Cons |
|---|---|---|
| A. 維持（受容根拠を docs に明文化するのみ） | コード変更ゼロ | 「出るが開けない」状態の追認にしかならない。security finding が閉じず再指摘され続ける |
| B. symlink file を一律に結果から落とす | 実装が最も単純 | fs:read で開ける in-root alias まで落ちる。境界が fs:read とズレたままになる |
| **C. 解決先が workspace 内なら出す（採用）** | fs:read と同じ境界に揃う。in-root alias は維持される | 分岐が 1 つ増える。symlink file にのみ realpath コストが乗る |

当初 C は「realpath コストを scan 全 file に払う」案と理解されていた（#434 issue 本文）が、上記のとおり **O_NOFOLLOW 失敗を検出トリガにすることで通常 file の追加コストはゼロ**になる。この点が判明したことで C の Cons が消え、採用に至った。

errno は**見分けない**。ELOOP 以外の失敗（EACCES / ENOENT 等）も同じ fallback に倒れ、解決先が null なら skip、非 null なら plain read を試す。**境界判定そのものは errno に依存しない**（symlink かどうかは realpath が答える）。ELOOP だけを fallback させる実装との差は transient な失敗（EMFILE 等）の扱いに出て、その場合 plain read が成功して file は結果に残る = ユーザー有利側にズレるだけで、境界は破れない。プラットフォーム差（Linux は ELOOP、BSD 系は EMLINK を返し得る）に実装が依存しない利点もある。

## Consequences

### 良い影響

- 「検索結果に出るのにクリックすると Permission denied」というユーザー可視の破綻が解消する
- 認可境界の説明が「fs:read で開けるか」の 1 つに収束する。#399 以来 4 回のレビューで繰り返し議論された「index / L2 / scan で境界が違う」構造が無くなる
- L2 admission の不変条件（#416）と scan の可視範囲が同じ判定（O_NOFOLLOW read の成否 + `resolveInsideRoot`）から導かれるようになり、片方だけ退行させる変更が test で落ちる
- `root` が index の有無と独立に必須になったことで、#407 Finding 1/3 が型で封じた「認可 root の指定漏れ」がさらに強く保証される（index を渡さない caller も root を省けない）

### 注意すべき影響

- **FileTree との非対称は残る**。`listDirectory` は readdir の結果をそのまま返すので、workspace 外を指す symlink は**一覧には出る**（クリックすると従来どおり開けない）。揃えるには entry ごとの realpath コストを新規に背負うことになるため、本 ADR のスコープ外とし別判断とする
- **Windows ではゲート未評価経路の境界が効かない**。`fs.constants.O_NOFOLLOW` が無く flag が 0 に落ちるため、分岐 3（index 未提供 / index 無効 / 既に index 済みで valid）では末端 symlink が検出されず、従来どおり内容が結果に出る。一方 **分岐 2 は realpath ベースの判定なので Windows でも効く**（index 稼働中の未 index file は外部 symlink が落ちる）。結果として Windows では index の状態によって結果集合が変わる非一貫性が残る。#412 で受容済みの posture と同じ（Windows の symlink 作成は既定で管理者特権または開発者モードを要するため、攻撃前提が成立しにくい）
- **hard link alias は検出できない**（#416 Finding 2 / [#416](https://github.com/ymnao/scripta/issues/416)）。hard link は O_NOFOLLOW でも realpath でも素通りするため、本 ADR の境界の対象外
- **retarget 直後は両者が一時的にズレる**。scan 側の `resolveInsideRoot` は realpath cache を通さず毎回 fresh に解決する（#406 Finding 1）のに対し、fs:read 側の `assertPathAllowed` は `realpathBestEffort` 経由で **LRU 256 件の `realpathCache`** を使い、symlink の retarget に対する明示的な invalidation を持たない（`path-guard.ts` の cache doc に受容として記載済み）。したがって symlink を張り替えた直後、その path が cache に載っていると「scan は新しい解決先で判定し、fs:read は古い判定を返す」窓が開く。本 ADR の不変条件は **fs:read 側の cache が fresh な範囲で** 成立する。窓を閉じるには user-IPC 側の realpath 鮮度を見直す必要があり、これは [#418](https://github.com/ymnao/scripta/issues/418) の判断対象（`assertPathAllowed` の O_NOFOLLOW 整合）と同じ層の話なのでそちらに委ねる
- **L2 hit 経路はゲートを評価した pass でしか可視範囲を判定できない**。「通常 file として L2 に載った後、watcher が拾えない retarget で workspace 外 symlink 化した」path は、その pass で index ゲートが走れば（既に払った realpath の再利用で）結果から落ちるが、ゲートを評価しない pass（index 無効 / 既に valid / index 未提供）では L2 の内容がそのまま返る。返るのは認可済みだった過去の実体の内容なので**外部内容の漏洩ではない**が、「結果に出るのにクリックすると開けない」状態は L2 entry が evict されるまで残る。判定材料を得るには L2 hit ごとに realpath を払うことになり、L2 hit の存在意義（read を省く）を打ち消すため受容する
- #412 で受容した「認可後に末端を swap された file はその pass の結果から落ちる」の影響範囲が広がる。従来は次の pass で plain read されて結果に戻っていたが、本 ADR 以降は **swap が戻されるまで結果に出ない**（fs:read も同じ理由で拒否するので一貫している）

### 関連する将来の検討事項

- FileTree（`listDirectory`）/ コマンドパレットのファイル名検索（SR-4）/ wikilink の解決先 stem 集合で、workspace 外を指す symlink をどう扱うか。いずれも file を読まない経路なので、揃えるには file list 構築時の realpath コストをどう払うかの判断が要る
- hard link alias の検出（ino/dev 突合）を入れるかどうか — stat コストが全 file に乗るため #416 Finding 2 で保留中

## References

- Issue: [#434](https://github.com/ymnao/scripta/issues/434)（本 ADR の判断対象）
- 関連 issue: [#399](https://github.com/ymnao/scripta/issues/399)（認可境界）/ [#406](https://github.com/ymnao/scripta/issues/406)（realpath ゲートの fresh 化と L2 swap-back）/ [#412](https://github.com/ymnao/scripta/issues/412)（O_NOFOLLOW read）/ [#413](https://github.com/ymnao/scripta/issues/413)（index disabled ゲート / alias）/ [#416](https://github.com/ymnao/scripta/issues/416)（L2 admission / hard link alias）
- 実装: `electron/main/ipc/search.ts`（`processMdFilesParallel`）/ `electron/main/utils/read-nofollow.ts` / `electron/main/utils/path-guard.ts`（`resolveInsideRoot` / `assertPathAllowed`）
