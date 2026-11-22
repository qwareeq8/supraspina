#!/usr/bin/env bash
# Brainstem subfields: segmentation of every participant, then the group models.
# Usage: run.sh [--process-only | --stats-only]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/cfg.sh"
mode=${1:-all}
case $mode in all | --process-only | --stats-only) ;; *) echo "Usage: run.sh [--process-only | --stats-only]"; exit 2 ;; esac
if [ "$mode" != --stats-only ]; then
  bash "$HERE/segment.sh"
fi
if [ "$mode" != --process-only ]; then
  "$PYTHON" "$HERE/stats.py"
fi
