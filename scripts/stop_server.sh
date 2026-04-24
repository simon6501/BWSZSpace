#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/logs/bwsz-space.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "BW&SZ's space is not running: missing PID file."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped BW&SZ's space. PID: $PID"
else
  echo "Process $PID is not running."
fi
rm -f "$PID_FILE"
