#!/usr/bin/env bash
# Thalamic nuclei: segmentation, nucleus table, blind QC montages and flags, then the group models.
# Usage: run.sh [--process-only | --stats-only]
# Between the two steps, rate every montage (<work_dir>/thalamus/qc/montages/<code>.png; second_look.py CODE and
# montage_aligned.py CODE for flagged or rotated cases) as Pass, Doubtful, or Fail into the private file
# qc.thalamus_ratings. The statistics refuse to run while a participant lacks a rating.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/cfg.sh"
export MPLCONFIGDIR=${MPLCONFIGDIR:-${TMPDIR:-/tmp}/mpl}
mode=${1:-all}
case $mode in all | --process-only | --stats-only) ;; *) echo "Usage: run.sh [--process-only | --stats-only]"; exit 2 ;; esac
cd "$HERE"
if [ "$mode" != --stats-only ]; then
  bash segment.sh
  "$PYTHON" montage.py
  "$PYTHON" build_table.py
  "$PYTHON" qc_flags.py
  echo "Rate the montages into qc.thalamus_ratings before the statistics."
fi
if [ "$mode" != --process-only ]; then
  "$PYTHON" stats.py
fi
