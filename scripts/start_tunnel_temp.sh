#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDFLARED="$ROOT/bin/cloudflared"

if [[ ! -x "$CLOUDFLARED" ]]; then
  if command -v cloudflared >/dev/null 2>&1; then
    CLOUDFLARED="$(command -v cloudflared)"
  else
    echo "cloudflared is not installed. Run: ./scripts/install_cloudflared_local.sh"
    exit 1
  fi
fi

echo "Starting temporary public tunnel for http://127.0.0.1:3077"
echo "Keep this terminal open. Copy the trycloudflare.com URL when it appears."
"$CLOUDFLARED" tunnel --url http://127.0.0.1:3077
