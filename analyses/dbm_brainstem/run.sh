#!/usr/bin/env bash
# Brainstem deformation-based morphometry, in order.
#   run.sh                 processing, then statistics
#   run.sh --process-only  FOV check, crops, template, registrations, regions, QC flags and pages
#   run.sh --stats-only    regional statistics, voxelwise design, randomise, and voxel summary
# Between the two parts, review qc_png/ (with reg_flags.txt) and list any failed registration in
# qc.dbm_registration_exclusions (an empty file means none). The template and registrations take hours
# on 12 cores; randomise takes about an hour.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$HERE/../lib/cfg.sh"
DO_P=1; DO_S=1
case "${1:-}" in
  --process-only) DO_S=0 ;;
  --stats-only) DO_P=0 ;;
  "") ;;
  *) echo "Unknown option $1." >&2; exit 2 ;;
esac
if [ $DO_P = 1 ]; then
  "$PYTHON" "$HERE/01_fov_check.py"
  "$PYTHON" "$HERE/02_crop.py"
  "$HERE/10_template.sh"
  "$HERE/20_register_all.sh"
  "$PYTHON" "$HERE/22_roi.py"
  "$PYTHON" "$HERE/22b_flags.py"
  "$PYTHON" "$HERE/23_qc_png.py"
fi
if [ $DO_S = 1 ]; then
  "$PYTHON" "$HERE/24_stats.py"
  "$PYTHON" "$HERE/25_design.py"
  "$HERE/26_randomise.sh"
  "$PYTHON" "$HERE/27_voxel_summary.py"
fi
