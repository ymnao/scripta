# 探索的 QA チェックリスト（v0.2.0 リリース前）

> 関連 issue: #94 (B セクション)
>
> 本ドキュメントは **Phase 1 (#82) 着手前** に、packaged build で typical workflow を一通り体験し **未検出の bug を全件洗い出す** ための探索ガイドである。
>
> 既知 bug (テーブル系 #88/#89/#90 / リスト系 #91/#92 / PDF 系 #79/#93 / ショートカット系) は **重複起票しない**。本 QA はあくまで「未知領域」を見つけることが目的。
>
> parity-checklist 🟡 (#94 A) は Tauri purge Phase 4 完了後に別途消化する（Tauri purge 中に挙動が変わる項目があるため、QA タイミングを分離）。

## 0. 進行スタイル

- Claude が「触るべき領域」と「過去類似 bug が出た箇所のヒント」を提示
- user が **チェックリスト + 自由探索** のハイブリッドで探索
- 発見した「おかしいな？」は **直感ベース** で OK。後で Claude が再現 / 根本原因調査 / issue 起票
- timebox: **30 分〜60 分**（疲れたら止める。1 セッションで完璧を目指さない）

## 1. 事前準備

```bash
# packaged build を生成
pnpm dist

# release/ ディレクトリに DMG / installer が出る
# macOS の場合は release/scripta-*.dmg を開いてマウント → /Applications/scripta.app へドラッグ
# 起動: open -a scripta
```

**注意**: 必ず **packaged build** で実施する。`pnpm dev` は HMR + dev server 経由で、PDF export / アプリ起動経路 / Settings 永続化 / Asset URL 経路の bug を見落とす。

## 2. 探索シナリオ（既知 bug を避けて広く触る）

### 2.1 起動 / ワークスペース管理

- [ ] 初回起動（settings.json なし）でデフォルト状態が表示されるか
- [ ] ワークスペースを開く → 再起動 → 同じワークスペースが復元されるか
- [ ] ワークスペースパスに **スペース / 日本語 / 特殊文字** を含むディレクトリを試す
- [ ] 存在しないワークスペースパス（手動で `settings.json` を編集して指定）を開いた時のエラー挙動
- [ ] 複数ワークスペースを連続切替（5 回くらい）して状態がリークしないか
- [ ] **ヒント**: 過去の Tauri 版で settings migration 周りに細かい挙動差があった (Phase 4 で精査予定)

### 2.2 ファイルツリー / ファイル操作

- [ ] 大量ファイル（**100+ files、5 階層以上**）のワークスペースでツリー表示
- [ ] ファイル名検索 / 全文検索のレスポンス時間
- [ ] **隠しファイル / gitignore パターン**で除外したファイルが本当に出ないか (issue #45)
- [ ] ファイル新規作成 → 即座にツリー反映されるか (chokidar watcher)
- [ ] ファイルを外部エディタで編集 → アプリ側でリロード反映されるか
- [ ] ファイル名に **絵文字 / 記号** を含めて新規作成
- [ ] ファイル削除（ゴミ箱移動）→ macOS Finder のゴミ箱に入るか
- [ ] **ヒント**: chokidar の挙動は OS で差がある。 macOS で試して怪しければ Linux でも試したいところだが本 QA では macOS のみで OK

### 2.3 エディタ / Markdown 編集

- [ ] **日本語入力 (IME)**: 変換中に他のキー操作（矢印 / Esc / Tab）を混ぜる
- [ ] **絵文字 / サロゲートペア** を含む文字を編集 / 削除（バックスペースで 1 動作で消えるか）
- [ ] 巨大ファイル（**10MB+ / 10000+ 行**）を開いてスクロール / 検索
- [ ] 同じファイルを 2 タブで開いて両方編集（衝突挙動）
- [ ] **Undo / Redo を 100 回連続** で打鍵してクラッシュしないか
- [ ] **ヒント**: テーブル / リスト / 見出しショートカットは既知 bug 7 件カバー済み (#88-#92)。これら以外で異常な挙動がないか

### 2.4 Live Preview（数式 / コード / リンク / 画像）

- [ ] **KaTeX 数式**: `$$...$$` / `$...$` インライン + ディスプレイ
- [ ] KaTeX で **`\\` (改行) / `\begin{align}` / `\cases`** などの複雑構文
- [ ] **Mermaid**: flowchart / sequence / class / gantt / pie / journey / gitGraph / ER 全 8 種
  - 注: 8 種すべての確認は Phase 1 #82 C の safety net で網羅する。今は「ぱっと見」で OK
- [ ] **コードブロック**: 主要言語 (TypeScript / Python / Rust / Bash) の syntax highlighting
- [ ] **画像**: 相対パス `![](img.png)` / 絶対パス / **wikilink-image** `![[img.png]]` (旧 Tauri 版の `convertFileSrc` 経由 → 新版は `scripta-asset://`)
- [ ] **リンク**: 内部 wikilink `[[foo]]` / 外部 URL クリックでブラウザ起動
- [ ] **OGP リンクカード**: 外部 URL のメタ情報取得とプレビュー (sanitize 効いているか)
- [ ] **ヒント**: PDF 改ページバグは #93 で調査中。Live Preview の数式描画は #79 が CSS CDN URL のずれを指摘済み (CDN は 0.16.33 固定だがブラウザ表示は別 path)

### 2.5 Export (PDF / HTML)

- [ ] 数式を含む Markdown → PDF export → ビューア（macOS Preview）で表示
- [ ] Mermaid 図を含む Markdown → PDF / HTML export
- [ ] 画像（相対パス / wikilink-image）を含む Markdown → PDF export で画像が出るか
- [ ] PDF export の **ファイル名** に日本語 / 絵文字 / 特殊文字を含めて保存
- [ ] HTML export → 出力 HTML を別タブで開き、CSS / 数式 / 画像が独立して表示できるか
- [ ] **ヒント**: 既知 bug は #79 (CSS CDN URL 古い) / #93 (改ページ過剰)。これ以外の異常 (フォントずれ / 改行位置 / 表崩れ) を見たい

### 2.6 Git Sync

- [ ] Git 管理下のワークスペースを開いて status 表示
- [ ] commit / push / pull を試す
- [ ] HTTPS remote の認証（macOS keychain 連携 / token prompt）
- [ ] SSH remote の認証（ssh-agent 連携）
- [ ] conflict 発生時の挙動（`conflict-resolver` ウィンドウ）
- [ ] **ヒント**: parity-checklist § 4 で「Git remote 認証実機」が要検証。Phase 6 でやる予定だが、簡単に確かめておきたい

### 2.7 設定 / テーマ

- [ ] テーマ切替 (light / dark / system) → 再起動後も保持
- [ ] **system テーマ** で OS のテーマを切り替えた時の即時反映
- [ ] フォントサイズ / フォントファミリ変更 → 再起動後も保持
- [ ] **設定ダイアログを開き直して** 値が保存されているか
- [ ] **ヒント**: 設定永続化は Phase 1 #82 C の safety net で網羅予定。今は visual に保存ボタンが動くかだけ

### 2.8 ウィンドウ管理 / メニュー

- [ ] アプリケーションメニュー (Cmd+, / Cmd+Q / Cmd+W) が機能するか
- [ ] フルスクリーン / Mission Control での挙動
- [ ] **複数ウィンドウ** を開いて conflict-resolver と main ウィンドウの labels 衝突
- [ ] アプリ終了時の確認ダイアログ (未保存変更ありの場合)

### 2.9 アップデートチェック

- [ ] アップデートチェック (メニューから) → GitHub Releases API への通信が成立するか
- [ ] 既に最新版の場合の通知 UI
- [ ] **ヒント**: parity-checklist § 11 でも要検証。Phase 6 で実施するが、軽く触る

### 2.10 エラーシナリオ

- [ ] 削除されたファイルを開いたタブで操作 (read / write エラー)
- [ ] 権限エラー (chmod 000 したファイルを開く)
- [ ] ディスク満杯シミュレート（小さい RAM disk 等で）→ save エラー
- [ ] ネットワーク切断状態で Git push / OGP fetch
- [ ] **ヒント**: エラー時に **ユーザーに分かりやすいメッセージ** が出るか？ silent fail していないか？

## 3. 「おかしいな？」を見つけた時の対応

- 即座に止めて **症状を書き留める** (どの操作で / 何が起きたか / 期待 vs 実態)
- 再現手順を **3 回試して** 安定再現か flaky か判定
- スクリーンショット撮影（クリップボード: `Cmd+Ctrl+Shift+4` / ファイル保存: `Cmd+Shift+4`）
- 本ドキュメントの「## 4. 発見した bug ログ」セクションに記録

## 4. 発見した bug ログ（QA 中に記入）

下記テンプレートを使って各 bug を記録。後で Claude が issue 化する。

```markdown
### bug-N: <短いタイトル>

- **発生領域**: (例: Editor / FileTree / PDF Export / Settings)
- **再現手順**: (3 step 程度)
- **期待**: (どう動くべきか)
- **実態**: (実際に何が起きたか)
- **再現性**: 安定 / 時々 / 1 回のみ
- **severity (体感)**: critical (データ損失) / serious (機能不全) / minor (UX 微妙) / nit (見た目)
- **スクショ**: (任意)
- **既知 issue との関連**: 既存 #88-#93 のどれかと類似か / 独立か
```

### bug-1: <短いタイトル>

(QA 中に記入)

## 5. QA 後の手順 (Claude 側で実施)

QA 終了後に user が本ファイルの「## 4. 発見した bug ログ」を埋めた状態で渡すと、Claude が:

1. 各 bug を **issue 化** (`fix:` prefix / `bug` label / v0.2.0 milestone デフォルト)
2. severity / cost 推定を **本文に記載**
3. 既存 #88-#93 と統合可能か **提案** (Q10 採用方針: 都度判定)
4. user が milestone 振り分けを判定 (v0.2.0 / v0.2.1 / v1.0.0 / wontfix) — Q6 採用方針
5. v0.2.0 milestone の bug 集合が **freeze** された状態で Phase 1 (#82) 着手

## 6. 参考: 既知 bug (本 QA で重複起票しない領域)

| # | 領域 | タイトル要約 |
|---|---|---|
| #79 | PDF | KaTeX CSS CDN URL が `katex@0.16.33` 固定 (bundle と乖離) |
| #88 | Editor / Table | テーブル挿入ショートカットを Mod-Shift-T に統一 |
| #89 | Editor / Table | テーブルセル内ペーストの修復 |
| #90 | Editor / Table | テーブル境界カーソル挙動修正 |
| #91 | Editor / List | リスト/タスク/見出しショートカット後のカーソル位置 |
| #92 | Editor / List | リスト系で Enter による自動継続 |
| #93 | PDF | PDF 改ページが過剰の調査と修正 |

これらの領域で「あれ？」と思ったら **重複再現か確認** してから記録すること。
