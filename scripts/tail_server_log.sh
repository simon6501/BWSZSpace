#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
touch "$ROOT/logs/bwsz-space.log"
tail -f "$ROOT/logs/bwsz-space.log"
