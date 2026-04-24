#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"
TARGET="$BIN_DIR/cloudflared"
PARTIAL="$TARGET.part"
URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"

mkdir -p "$BIN_DIR"

if [[ -f "$TARGET" ]]; then
	echo "cloudflared already exists, skip download: $TARGET"
	chmod +x "$TARGET"
	"$TARGET" --version
	exit 0
fi

echo "Downloading cloudflared for linux amd64..."
echo "Source: $URL"
CONNECT_TIMEOUT="${CLOUDFLARED_CONNECT_TIMEOUT:-30}"
MAX_TIME="${CLOUDFLARED_MAX_TIME:-0}"

CURL_ARGS=(
	-L
	--fail
	--retry 6
	--retry-delay 3
	--retry-all-errors
	--connect-timeout "$CONNECT_TIMEOUT"
	--continue-at -
	-o "$PARTIAL"
)

if [[ "$MAX_TIME" != "0" ]]; then
	CURL_ARGS+=(--max-time "$MAX_TIME")
fi

curl "${CURL_ARGS[@]}" "$URL"
chmod +x "$PARTIAL"
mv "$PARTIAL" "$TARGET"

echo "Installed: $TARGET"
"$TARGET" --version
