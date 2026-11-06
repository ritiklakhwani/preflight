#!/usr/bin/env bash
# Starts the approval server and exposes it over HTTPS with a Cloudflare quick
# tunnel (no account). The push link carries the tunnel URL to the phone.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cloudflared >/dev/null || brew install cloudflared
log=$(mktemp)
cloudflared tunnel --url "http://localhost:${APPROVE_PORT:-8787}" >"$log" 2>&1 &
for _ in $(seq 1 30); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)
  [ -n "$url" ] && break
  sleep 1
done
echo "Approval server public URL: $url"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
APPROVE_API_URL="$url" APPROVE_PUBLIC_URL="https://${repo%%/*}.github.io/${repo##*/}" \
  pnpm --filter @preflight/approve start
