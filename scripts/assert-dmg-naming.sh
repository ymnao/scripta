#!/usr/bin/env bash
# Homebrew Cask (issue #282) の URL テンプレート
# `scripta-<version>[-arm64].dmg` は electron-builder 26.x の default artifactName
# に依存している (drift-lock 方針は docs/parity-checklist.md §11)。
# dmg のセットが期待値と完全一致することを assert して drift を即検出する。
# 想定値以外の dmg が余分に出た場合 (e.g. x64 に `-x64` suffix が付いた) も検出
# 対象なので、単純な存在確認ではなく set match で判定する。
#
# release.yml (tag push 時の release 生成) と verify-dmg-naming.yml
# (PR 時の preventive gate) の両方から呼ばれる。
#
# `find` を使うのは、`ls *.dmg` は 0 match 時に非零 exit して pipefail 下で
# コマンド置換ごと abort し、assert 到達前に script が落ちて `::error::`
# annotation が出ないため (0 dmg の場合も明示的な drift 診断メッセージが要る)。
set -eo pipefail

version=$(jq -r .version package.json)
expected=$(printf 'scripta-%s-arm64.dmg\nscripta-%s.dmg\n' "$version" "$version" | sort)
actual=$(find release -maxdepth 1 -type f -name '*.dmg' -exec basename {} \; | sort)

if [ "$expected" != "$actual" ]; then
  echo "::error::dmg naming contract broken (issue #282 Cask URL depends on this). Expected: ${expected//$'\n'/ } | Actual: ${actual//$'\n'/ }"
  exit 1
fi
