#!/usr/bin/env bash
# Exploratory volumes: hypothalamic subunits and CerebNet cerebellar lobules, then their single tests.
# Usage: run.sh [--process-only | --stats-only]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/cfg.sh"
export OMP_NUM_THREADS=3 OPENBLAS_NUM_THREADS=3 MKL_NUM_THREADS=3
mode=${1:-all}
case $mode in all | --process-only | --stats-only) ;; *) echo "Usage: run.sh [--process-only | --stats-only]"; exit 2 ;; esac
cd "$HERE"
if [ "$mode" != --stats-only ]; then
  bash 00_check_inputs.sh
  bash 10_hypothalamus.sh
  bash 20_cerebnet.sh
  "$PYTHON" 30_extract.py
fi
if [ "$mode" != --process-only ]; then
  nice -n 15 "$PYTHON" 40_stats.py
fi
