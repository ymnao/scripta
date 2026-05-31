#!/usr/bin/env bash
# Tauri / WKWebView 残骸検出 CI ガード (Issue #82 サブタスク D / Phase 1 PR-2)。
#
# Phase 1 時点では既存残骸 (A 純 dead code / B 構造的レガシー / C コメント、
# 合計 ~90 行) が大量にあるため意図的に fail する。Phase 2-5 完了で green
# になる前提で先に設置し、進捗の質的尺度として運用する。
#
# FORBIDDEN keyword 一覧と対象スコープは docs/tauri-purge-inventory.md
# §2.1 / §2.2 と同期させる。false positive (-webkit- prefix CSS 等) は
# §2.6 を参照 — keyword に `WebKit` を含めないことで FP を回避している。

set -euo pipefail

FORBIDDEN='tauri|wkwebview|__TAURI|webviewWindow|@tauri-apps|src-tauri|tauri://|tauri-plugin|data-tauri-|convertFileSrc|WebviewWindow|appWindow|tauri\.conf'

# 対象スコープ: PR-1 inventory §2.1 と完全一致。
# docs/ は移行記録 (parity-checklist / tauri-purge-inventory 自身) のため除外。
PATHS=(
  'src/'
  'electron/'
  'electron-builder.yml'
  'package.json'
  'electron.vite.config.ts'
  'biome.json'
  'tsconfig.node.json'
  'tsconfig.web.json'
  'tsconfig.e2e.json'
  'vitest.config.ts'
  'playwright.config.ts'
  '.github/'
)

# 自分自身は FORBIDDEN 文字列を含むため除外。
EXCLUDE=(
  ':(exclude)scripts/check-tauri-residue.sh'
)

if RESULT=$(git grep -niE "$FORBIDDEN" -- "${PATHS[@]}" "${EXCLUDE[@]}"); then
  COUNT=$(printf '%s\n' "$RESULT" | wc -l | tr -d ' ')
  echo "❌ Tauri 残骸検出: ${COUNT} 行"
  echo
  echo "$RESULT"
  echo
  echo "詳細分類は docs/tauri-purge-inventory.md を参照:"
  echo "  - §2.3 A: 純 dead code (Phase 2 担当)"
  echo "  - §2.4 B: 構造的レガシー (Phase 3 担当)"
  echo "  - §2.5 C: ドキュメンタリーコメント (Phase 3 担当)"
  echo "  - §2.6 D: false positive (-webkit- prefix CSS 等、本 script は検出せず)"
  exit 1
fi

echo "✅ Tauri 残骸なし"
