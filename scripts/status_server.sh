#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/logs/bwsz-space.pid"
LOG_FILE="$ROOT/logs/bwsz-space.log"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Status: running"
  echo "PID: $(cat "$PID_FILE")"
else
  echo "Status: stopped"
  rm -f "$PID_FILE"
fi

echo "Local URL: http://127.0.0.1:3077"
echo "Log: $LOG_FILE"
