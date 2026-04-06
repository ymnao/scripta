#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: $0 <version>  (e.g. 0.2.0)}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: '$VERSION' is not valid semver (expected X.Y.Z)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Portable in-place sed
sedi() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# package.json
sedi "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/package.json"

# tauri.conf.json
sedi "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$REPO_ROOT/src-tauri/tauri.conf.json"

# Cargo.toml — [package] セクション内の version のみ置換
CARGO_TOML="$REPO_ROOT/src-tauri/Cargo.toml"
awk -v ver="$VERSION" '
  /^\[package\]$/ { in_package=1; print; next }
  in_package && /^\[/ { in_package=0 }
  in_package && /^version = "[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"$/ {
    print "version = \"" ver "\""
    next
  }
  { print }
' "$CARGO_TOML" > "$CARGO_TOML.tmp" && mv "$CARGO_TOML.tmp" "$CARGO_TOML"

# Cargo.lock のパッケージバージョンのみ直接編集
# クレート名は Cargo.toml の [package] name から取得
CARGO_LOCK="$REPO_ROOT/src-tauri/Cargo.lock"
CRATE_NAME=$(awk '/^\[package\]$/ { in_pkg=1; next } in_pkg && /^\[/ { exit } in_pkg && /^name = "/ { gsub(/"/, "", $3); print $3; exit }' "$CARGO_TOML")
if [[ -z "$CRATE_NAME" ]]; then
  echo "error: could not read crate name from Cargo.toml" >&2
  exit 1
fi
awk -v ver="$VERSION" -v name="$CRATE_NAME" '
  $0 == "name = \"" name "\"" { found=1 }
  found && /^version = "/ {
    print "version = \"" ver "\""
    found=0
    replaced=1
    next
  }
  { print }
  END {
    if (!replaced) {
      print "error: " name " package not found in Cargo.lock" > "/dev/stderr"
      exit 1
    }
  }
' "$CARGO_LOCK" > "$CARGO_LOCK.tmp" && mv "$CARGO_LOCK.tmp" "$CARGO_LOCK"

# 置換結果を検証
verify() {
  local file="$1" actual="$2"
  if [[ "$actual" != "$VERSION" ]]; then
    echo "error: $file version is '$actual', expected '$VERSION'" >&2
    exit 1
  fi
}

verify "package.json" "$(jq -r '.version' "$REPO_ROOT/package.json")"
verify "tauri.conf.json" "$(jq -r '.version' "$REPO_ROOT/src-tauri/tauri.conf.json")"
verify "Cargo.toml" "$(sed -n 's/^version = "\(.*\)"/\1/p' "$CARGO_TOML" | head -1)"
verify "Cargo.lock" "$(awk -v name="$CRATE_NAME" '$0 == "name = \"" name "\"" { found=1 } found && /^version = "/ { gsub(/"/, "", $3); print $3; exit }' "$CARGO_LOCK")"

echo "Bumped to $VERSION"
echo "  package.json"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.toml"
echo "  src-tauri/Cargo.lock"
