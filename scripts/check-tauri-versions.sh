#!/usr/bin/env bash
# Tauri プラグインの Rust クレートと npm パッケージのバージョン整合性を検証する。
# Cargo.lock（安定フォーマット）と pnpm list --json（構造化出力）を使用し、
# major.minor が異なる場合にエラーを返す。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 必須コマンドの存在チェック
for cmd in jq awk; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "error: $cmd is required but not found" >&2
    exit 1
  fi
done
CARGO_LOCK="$REPO_ROOT/src-tauri/Cargo.lock"
CARGO_TOML="$REPO_ROOT/src-tauri/Cargo.toml"

# Cargo.toml から tauri-plugin-* クレートを自動検出し、npm パッケージ名を導出
# 命名規則: tauri-plugin-X → @tauri-apps/plugin-X
PLUGINS=()
while IFS= read -r crate; do
  suffix="${crate#tauri-plugin-}"
  PLUGINS+=("${crate}:@tauri-apps/plugin-${suffix}")
done < <(grep -o 'tauri-plugin-[a-z0-9-]*' "$CARGO_TOML" | sort -u)

if [[ ${#PLUGINS[@]} -eq 0 ]]; then
  echo "warn: no tauri-plugin-* found in Cargo.toml" >&2
  exit 0
fi

# pnpm list から依存パッケージのバージョンを取得（JSON）
pnpm_list=$(cd "$REPO_ROOT" && pnpm list --json --depth=0) || {
  echo "error: pnpm list failed. Run 'pnpm install' first." >&2
  exit 1
}

errors=0

for entry in "${PLUGINS[@]}"; do
  crate="${entry%%:*}"
  npm_pkg="${entry##*:}"

  # Cargo.lock から解決済みバージョンを取得（完全一致）
  cargo_ver=$(awk -v name="$crate" '
    /^\[\[package\]\]/ { found=0 }
    $0 == "name = \"" name "\"" { found=1 }
    found && /^version = "/ { gsub(/"/, "", $3); print $3; exit }
  ' "$CARGO_LOCK")

  # package.json に npm 側が宣言されているか確認
  has_npm=$(echo "$pnpm_list" | jq -r --arg name "$npm_pkg" '
    .[0].dependencies[$name] // empty | if . == "" then "no" else "yes" end
  ')

  # Rust-only プラグイン（npm 側が package.json に未宣言）はスキップ
  if [[ "$has_npm" != "yes" ]]; then
    continue
  fi

  # pnpm list --json から解決済みバージョンを取得
  npm_ver=$(echo "$pnpm_list" | jq -r --arg name "$npm_pkg" '
    .[0].dependencies[$name].version // empty
  ')

  # 片側欠落はエラー（両方宣言されているのに解決済みバージョンが取れない）
  if [[ -z "$cargo_ver" ]]; then
    echo "error: $crate not found in Cargo.lock" >&2
    errors=$((errors + 1))
    continue
  fi
  if [[ -z "$npm_ver" ]]; then
    echo "error: $npm_pkg not found in pnpm list" >&2
    errors=$((errors + 1))
    continue
  fi

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
  echo "$errors mismatch(es) found." >&2
  echo "To sync, update the stale side:" >&2
  echo "  npm:   pnpm update <package>" >&2
  echo "  Rust:  cargo update -p <crate>" >&2
  exit 1
fi

echo "Tauri plugin versions OK"
