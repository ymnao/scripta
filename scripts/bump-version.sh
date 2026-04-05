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

# Cargo.lock を同期
(cd "$REPO_ROOT/src-tauri" && cargo generate-lockfile -q 2>/dev/null) ||
  (cd "$REPO_ROOT/src-tauri" && cargo check --lib -q)

echo "Bumped to $VERSION"
echo "  package.json"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.toml"
echo "  src-tauri/Cargo.lock"
