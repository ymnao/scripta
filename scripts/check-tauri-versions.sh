#!/usr/bin/env bash
# Tauri プラグインの Rust クレートと npm パッケージのバージョン整合性を検証する。
# Cargo.lock（安定フォーマット）と pnpm list --json（構造化出力）を使用し、
# major.minor が異なる場合にエラーを返す。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_LOCK="$REPO_ROOT/src-tauri/Cargo.lock"

# Rust クレート名 → npm パッケージ名
PLUGINS=(
  "tauri-plugin-dialog:@tauri-apps/plugin-dialog"
  "tauri-plugin-shell:@tauri-apps/plugin-shell"
  "tauri-plugin-store:@tauri-apps/plugin-store"
  "tauri-plugin-window-state:@tauri-apps/plugin-window-state"
)

# pnpm list から依存パッケージのバージョンを取得（JSON）
pnpm_list=$(cd "$REPO_ROOT" && pnpm list --json --depth=0 2>/dev/null)

errors=0

for entry in "${PLUGINS[@]}"; do
  crate="${entry%%:*}"
  npm_pkg="${entry##*:}"

  # Cargo.lock から解決済みバージョンを取得
  cargo_ver=$(awk -v name="$crate" '
    /^\[\[package\]\]/ { found=0 }
    $0 ~ "^name = \"" name "\"" { found=1 }
    found && /^version = "/ { gsub(/"/, "", $3); print $3; exit }
  ' "$CARGO_LOCK")

  # pnpm list --json から解決済みバージョンを取得
  npm_ver=$(echo "$pnpm_list" | jq -r --arg name "$npm_pkg" '
    .[0].dependencies[$name].version // empty
  ' 2>/dev/null)

  # いずれかが存在しない場合はスキップ
  [[ -z "$cargo_ver" || -z "$npm_ver" ]] && continue

  # major.minor を比較
  cargo_mm="${cargo_ver%.*}"
  npm_mm="${npm_ver%.*}"

  if [[ "$cargo_mm" != "$npm_mm" ]]; then
    echo "error: $crate ($cargo_ver) != $npm_pkg ($npm_ver)" >&2
    errors=$((errors + 1))
  fi
done

if [[ $errors -gt 0 ]]; then
  echo "" >&2
  echo "$errors mismatch(es) found. Run 'pnpm update <package>' to sync." >&2
  exit 1
fi

echo "Tauri plugin versions OK"
