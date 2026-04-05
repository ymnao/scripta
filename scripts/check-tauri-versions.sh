#!/usr/bin/env bash
# Tauri プラグインの Rust クレートと npm パッケージのバージョン整合性を検証する。
# Cargo.lock と pnpm-lock.yaml の解決済みバージョンを比較し、
# major.minor が異なる場合にエラーを返す。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CARGO_LOCK="$REPO_ROOT/src-tauri/Cargo.lock"
PNPM_LOCK="$REPO_ROOT/pnpm-lock.yaml"

# Rust クレート名 → npm パッケージ名
PLUGINS=(
  "tauri-plugin-dialog:@tauri-apps/plugin-dialog"
  "tauri-plugin-shell:@tauri-apps/plugin-shell"
  "tauri-plugin-store:@tauri-apps/plugin-store"
  "tauri-plugin-window-state:@tauri-apps/plugin-window-state"
)

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

  # pnpm-lock.yaml から解決済みバージョンを取得
  npm_ver=$(grep -o "${npm_pkg}@[0-9][0-9.]*" "$PNPM_LOCK" | head -1 | sed 's/.*@//')

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
