#!/usr/bin/env bash
# Cortical surfaces: buckner40 re-registration, screen, selection, review, extraction, then the group models.
# Usage: run.sh [--process-only | --stats-only]
# Processing stops after the screen until the group-blind review of the flagged hemispheres (unresolved
# hemispheres and visual flags; label overlays) is written to qc.cortical_adjudication; rerun --process-only
# afterwards to label the hemispheres kept with the default registration and to rebuild the tables.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/cfg.sh"
W=$(cfg work_dir)/cortex
export OMP_NUM_THREADS=3 OPENBLAS_NUM_THREADS=3 MKL_NUM_THREADS=3
mode=${1:-all}
case $mode in all | --process-only | --stats-only) ;; *) echo "Usage: run.sh [--process-only | --stats-only]"; exit 2 ;; esac
cd "$HERE"
if [ "$mode" != --stats-only ]; then
  "$PYTHON" 00_subjects.py
  bash 01_setup_sd.sh
  bash 03_queue.sh "$W/joblist_b40infl.txt" b40infl
  "$PYTHON" 10_screen.py b40infl
  "$PYTHON" 11_select.py
  if [ -s "$W/joblist_b40.txt" ]; then  # Fallback registration for hemispheres failing b40infl.
    bash 03_queue.sh "$W/joblist_b40.txt" b40
    "$PYTHON" 10_screen.py b40
    "$PYTHON" 11_select.py
  fi
  bash 03_queue.sh "$W/joblist_default.txt" default
  "$PYTHON" 12_extract.py
  "$PYTHON" 17_screen_summary.py
fi
if [ "$mode" != --process-only ]; then
  nice -n 15 "$PYTHON" 20_region.py
  nice -n 15 "$PYTHON" 40_somatotopic.py
  "$PYTHON" 50_summary.py
  "$PYTHON" 60_chain_export.py
  "$PYTHON" 70_euler.py
fi
