#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/logs/bwsz-space.pid"
LOG_FILE="$ROOT/logs/bwsz-space.log"

cd "$ROOT"
mkdir -p logs

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "BW&SZ's space is already running. PID: $PID"
    echo "Log: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

nohup npm start >> "$LOG_FILE" 2>&1 &
PID="$!"
echo "$PID" > "$PID_FILE"

echo "BW&SZ's space started. PID: $PID"
echo "Log: $LOG_FILE"
echo "Open: http://127.0.0.1:3077"
