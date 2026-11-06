#!/usr/bin/env bash
# Publishes the Pocket Approve PWA to GitHub Pages (gh-pages branch).
# The passkey is bound to the Pages domain, so keep using the same one.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter @preflight/approve build
out=$(mktemp -d)
cp -R apps/approve/web/dist/. "$out/"
touch "$out/.nojekyll"
remote=$(git remote get-url origin)
(
  cd "$out"
  git init -q -b gh-pages
  git add -A
  git commit -q -m "deploy Pocket Approve"
  git push -q -f "$remote" gh-pages
)
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api -X POST "repos/$repo/pages" -f "source[branch]=gh-pages" -f "source[path]=/" >/dev/null 2>&1 || true
echo "Published: https://${repo%%/*}.github.io/${repo##*/}/"
