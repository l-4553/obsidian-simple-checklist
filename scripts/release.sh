#!/usr/bin/env bash
#
# Cuts a new release: bumps package.json, package-lock.json, and manifest.json,
# builds, commits all pending changes, pushes the branch, then tags and pushes
# the tag — which triggers .github/workflows/release.yml to publish the release.
#
# Usage:
#   scripts/release.sh <version> <commit description>
#   scripts/release.sh 1.8.3 "fix navigation regression"
#
# Notes:
#   - Any tracked working-tree changes get folded into the release commit, so
#     stage your feature work (or have a clean tree) before running.
#   - Aborts if the tag already exists locally or on origin.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  cat >&2 <<USAGE
Usage: $(basename "$0") <version> <commit description>
Example: $(basename "$0") 1.8.3 "fix navigation regression"
USAGE
  exit 1
fi

VERSION="$1"
DESCRIPTION="$2"

cd "$(git rev-parse --show-toplevel)"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must look like X.Y.Z (got: $VERSION)" >&2
  exit 1
fi

if git rev-parse "refs/tags/$VERSION" >/dev/null 2>&1; then
  echo "error: local tag '$VERSION' already exists." >&2
  exit 1
fi
if git ls-remote --tags --exit-code origin "$VERSION" >/dev/null 2>&1; then
  echo "error: remote tag '$VERSION' already exists on origin." >&2
  exit 1
fi

# Surface pending changes so we don't silently bundle unrelated work into the
# release commit.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "==> Pending working-tree changes (will be included in the release commit):"
  git status --short
  read -r -p "Continue? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

echo "==> Bumping package.json, package-lock.json, and manifest.json to $VERSION"
npm version "$VERSION" --no-git-tag-version >/dev/null

node -e "
  const fs = require('fs');
  const version = process.argv[1];
  const manifestPath = 'manifest.json';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  if (pkg.version !== version) {
    console.error('error: package.json version is ' + pkg.version + ', expected ' + version);
    process.exit(1);
  }
  if (manifest.version !== version) {
    console.error('error: manifest.json version is ' + manifest.version + ', expected ' + version);
    process.exit(1);
  }
" "$VERSION"

echo "==> Building"
npm run build

echo "==> Committing"
git add -u
git add package.json package-lock.json manifest.json
git commit -m "$VERSION: $DESCRIPTION"

echo "==> Pushing branch"
git push

echo "==> Tagging $VERSION and pushing"
git tag "$VERSION"
git push origin "$VERSION"

REMOTE_URL=$(git config --get remote.origin.url || true)
REPO_PATH=$(echo "$REMOTE_URL" | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')

cat <<DONE

Release $VERSION pushed.
Workflow:  https://github.com/${REPO_PATH:-<owner/repo>}/actions
Releases:  https://github.com/${REPO_PATH:-<owner/repo>}/releases
DONE
