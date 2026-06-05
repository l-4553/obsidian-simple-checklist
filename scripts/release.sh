#!/usr/bin/env bash
#
# Cuts a new release: bumps version files, builds, commits all pending changes,
# pushes the branch, then tags and pushes the tag — which triggers the
# .github/workflows/release.yml workflow to publish the GitHub release.
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

echo "==> Bumping package.json + package-lock.json to $VERSION"
npm version "$VERSION" --no-git-tag-version >/dev/null

echo "==> Bumping manifest.json to $VERSION"
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  m.version = process.argv[1];
  fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
" "$VERSION"

echo "==> Building"
npm run build

echo "==> Committing"
git add -u
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
