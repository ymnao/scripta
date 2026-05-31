#!/usr/bin/env bash
# 旧 Tauri / WKWebView 由来の legacy keyword 検出 CI ガード
# (Issue #82 サブタスク D / Phase 1 PR-2)。
#
# Phase 1 時点では既存残骸 (A 純 dead code / B 構造的レガシー / C コメント、
# 合計 ~85 行) が大量にあるため意図的に fail する。Phase 2-5 完了で green
# になる前提で先に設置し、進捗の質的尺度として運用する。
#
# FORBIDDEN keyword 一覧と対象スコープは docs/tauri-purge-inventory.md
# §2.1 / §2.2 と同期させる。
#
# `WebKit` keyword は **意図的に FORBIDDEN から除外** している:
#   - `-webkit-` prefix CSS (line-clamp, font-smoothing, print-color-adjust 等)
#     と `WebkitAppRegion` 等 Chromium 用 CSS が大量に false positive 化する
#   - 旧 `WKWebView` 言及は別 keyword `wkwebview` (case-insensitive) で捕捉
#   - 残る "Safari/WebKit" 系コメント (例: src/lib/ime.ts:4) は Chromium でも
#     該当する正当な仕様なので CI 検出対象外。inventory §2.6 参照
#
# 自己参照回避のため、本 script と関連 workflow / package.json entry は
# "tauri" 文字列を含まないよう "legacy-residue" 命名に統一している。

set -uo pipefail

FORBIDDEN='tauri|wkwebview|__TAURI|webviewWindow|@tauri-apps|src-tauri|tauri://|tauri-plugin|data-tauri-|convertFileSrc|WebviewWindow|appWindow|tauri\.conf'

# 対象スコープ: PR-1 inventory §2.1 と同期。
# docs/ は移行記録 (parity-checklist / tauri-purge-inventory 自身) のため除外。
PATHS=(
  'src/'
  'electron/'
  'electron-builder.yml'
  'package.json'
  'pnpm-workspace.yaml'
  'electron.vite.config.ts'
  'vite.config.e2e.ts'
  'biome.json'
  'tsconfig.json'
  'tsconfig.node.json'
  'tsconfig.web.json'
  'tsconfig.e2e.json'
  'vitest.config.ts'
  'playwright.config.ts'
  '.github/'
)

# 本 script は FORBIDDEN 文字列を含むため (keyword 列挙) 除外。
# PATHS に `scripts/` を含めないため現状は no-op だが、将来 scripts/ を
# 検索対象にした場合に self-detection を防ぐ defensive な配置。
EXCLUDE=(
  ':(exclude)scripts/check-legacy-residue.sh'
)

# git grep の終了コード: 0 = match あり / 1 = match なし / ≥2 = エラー
# (not a git repo, ambiguous pathspec, missing file 等)。`if RESULT=$(...)`
# 単純パターンでは 1 と ≥2 を区別できず、エラー時に「✅ 残骸なし」と誤報
# するため、終了コードを明示的に捕捉して分岐する。
RESULT=$(git grep -niE "$FORBIDDEN" -- "${PATHS[@]}" "${EXCLUDE[@]}" 2>&1) || EXIT=$?
EXIT=${EXIT:-0}

case "$EXIT" in
  0)
    COUNT=$(printf '%s\n' "$RESULT" | wc -l | tr -d ' ')
    echo "❌ Tauri 残骸検出: ${COUNT} 行"
    echo
    echo "$RESULT"
    echo
    echo "詳細分類は docs/tauri-purge-inventory.md を参照:"
    echo "  - §2.3 A: 純 dead code (Phase 2 担当)"
    echo "  - §2.4 B: 構造的レガシー (Phase 3 担当)"
    echo "  - §2.5 C: ドキュメンタリーコメント (Phase 3 担当)"
    echo "  - §2.6 D: false positive (-webkit- prefix CSS / Safari/WebKit"
    echo "    系コメント等、本 script は検出せず)"
    exit 1
    ;;
  1)
    echo "✅ Tauri 残骸なし"
    exit 0
    ;;
  *)
    echo "ERROR: git grep failed (exit ${EXIT}). 出力:" >&2
    echo "$RESULT" >&2
    exit 2
    ;;
esac
