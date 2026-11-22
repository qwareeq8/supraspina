#!/usr/bin/env bash
# Medullary compartments on the brainstem DBM template, in order. Needs the brainstem DBM template and
# registrations (dbm_brainstem/run.sh --process-only).
#   run.sh                 processing, then statistics
#   run.sh --process-only  atlas reference crops and registrations, label warps, ROIs, QC pages, values
#   run.sh --stats-only    compartment, depth, and tectal statistics
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
  export FSLDIR="${FSLDIR:-$(cfg software.fsl_dir)}"
  C="$(cfg work_dir)/compartments"
  mkdir -p "$C/ref" "$C/reg_ref"
  # Allen atlas reference (ICBM 2009b nonlinear symmetric) and JHU reference (FSL MNI152 1 mm).
  "$PYTHON" "$HERE/10_crop_ref.py" "$(cfg atlases.icbm2009b_sym)" "$C/ref/icbm09bsym_crop.nii.gz"
  "$PYTHON" "$HERE/10_crop_ref.py" "$(cfg atlases.fsl_mni152_1mm)" "$C/ref/mni152fsl_crop.nii.gz"
  "$HERE/11_reg_ref.sh" "$C/ref/icbm09bsym_crop.nii.gz" "$C/reg_ref/icbm09bsym_"
  "$HERE/11_reg_ref.sh" "$C/ref/mni152fsl_crop.nii.gz" "$C/reg_ref/mni152fsl_"
  "$HERE/20_warp_labels.sh"
  "$PYTHON" "$HERE/21_rois.py"
  "$PYTHON" "$HERE/22_qc_png.py"
  "$PYTHON" "$HERE/23_roi_values.py"
fi
if [ $DO_S = 1 ]; then
  "$PYTHON" "$HERE/30_stats.py"
  "$PYTHON" "$HERE/31_posthoc_depth.py"
  "$PYTHON" "$HERE/32_tectal_control.py"
fi
