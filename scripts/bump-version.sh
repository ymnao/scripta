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

# Cargo.toml — semver パターンで [package] の version のみ置換
sedi "s/^version = \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/version = \"$VERSION\"/" \
  "$REPO_ROOT/src-tauri/Cargo.toml"

# Cargo.lock の app パッケージのバージョンのみ直接編集
# レジストリ不要・他の依存を一切変更しない決定的な操作
CARGO_LOCK="$REPO_ROOT/src-tauri/Cargo.lock"
awk -v ver="$VERSION" '
  $0 == "name = \"app\"" { found_app=1 }
  found_app && /^version = "/ {
    print "version = \"" ver "\""
    found_app=0
    replaced=1
    next
  }
  { print }
  END {
    if (!replaced) {
      print "error: app package not found in Cargo.lock" > "/dev/stderr"
      exit 1
    }
  }
' "$CARGO_LOCK" > "$CARGO_LOCK.tmp" && mv "$CARGO_LOCK.tmp" "$CARGO_LOCK"

echo "Bumped to $VERSION"
echo "  package.json"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.toml"
echo "  src-tauri/Cargo.lock"
