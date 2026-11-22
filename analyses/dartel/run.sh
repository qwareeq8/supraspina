#!/usr/bin/env bash
# SPM 25 DARTEL voxel-based morphometry (SPM 25.01.02, MATLAB R2026a; FSL randomise for the voxelwise map).
#   run.sh                 processing, then statistics
#   run.sh --process-only  stage the T1 crops, header check, Segment, origin check, template (plus warping of
#                          non-template scans to it), tissue volumes, normalization, mean images, QC montages,
#                          coverage, and region values
#   run.sh --stats-only    region statistics and the voxelwise white matter analysis
# The template is built from the scans in the optional private list dartel.template_participants (which may
# include scans outside the analyzed sample), else from all analyzed participants; analyzed participants outside
# the template are then registered to the finished template.
# Steps whose outputs exist are skipped (SEG_DONE, TEMPLATE_DONE, flow fields, normalized images, finished
# randomise chunks). Participant-level
# outputs and logs go to <work_dir>/dartel, group-level ones to <output_dir>/dartel.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../lib/cfg.sh"
PROC=1
STATS=1
case "${1:-}" in
  --process-only) STATS=0 ;;
  --stats-only) PROC=0 ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
WORK="$(cfg work_dir)/dartel"
OUT="$(cfg output_dir)/dartel"
SPM=$(cfg software.spm_dir)
MATLAB=$(cfg software.matlab)
THREADS=$(cfg software.threads)
L=$WORK/lists
LIST=$L/participants.txt
export MPLCONFIGDIR="${TMPDIR:-/tmp}/mpl"
mkdir -p "$WORK/lists" "$WORK/logs/seg" "$OUT"
py() { "$PYTHON" "$HERE/$1" "${@:2}"; }
# One single-threaded MATLAB session; paths reach the functions as arguments.
mrun() { "$MATLAB" -singleCompThread -nodisplay -batch "addpath('$HERE'); $2" < /dev/null > "$WORK/logs/$1.log" 2>&1; }
# Usage: n_with LISTFILE PREFIX SUFFIX. Count the IDs in LISTFILE whose file <prefix><id><suffix> exists.
n_with() { local n=0 s; while read -r s; do if [ -f "$2$s$3" ]; then n=$((n + 1)); fi; done < "$1"; echo "$n"; }

if [ "$PROC" = 1 ]; then
  py 01_stage_inputs.py             # Also writes lists/{participants,segment,template,warp}.txt.
  py 02_header_check.py
  # Unified segmentation of every scan (analyzed and template-only), one MATLAB each, up to THREADS at a time.
  while read -r s; do
    [ -f "$WORK/seg/$s/SEG_DONE" ] && continue
    while [ "$(jobs -rp | wc -l)" -ge "$THREADS" ]; do wait -n || true; done
    mrun "seg/$s" "dartel_segment('$WORK/seg/$s/${s}_T1w.nii', '$WORK/raw/${s}_mask.nii', '$SPM')" &
  done < "$L/segment.txt"
  wait
  N_SEG=$(wc -l < "$L/segment.txt")
  n_seg=$(n_with "$L/segment.txt" "$WORK/seg/" /SEG_DONE)
  echo "Segment: $n_seg of $N_SEG scans done."
  [ "$n_seg" -eq "$N_SEG" ] || { echo "Segment failed for some scans; see logs/seg." >&2; exit 1; }
  py 03_seg_montage.py || true    # QC montages, rated by eye.
  py 04_origin_check.py
  # Template creation also gives each template scan's flow field; the other analyzed scans are warped to it.
  [ -f "$WORK/dartel/TEMPLATE_DONE" ] || mrun template "dartel_template('$WORK', '$L/template.txt', '$SPM')"
  : > "$L/warp_todo.txt"
  while read -r s; do
    [ -f "$WORK/dartel/$s/u_rc1${s}_T1w.nii" ] || echo "$s" >> "$L/warp_todo.txt"
  done < "$L/warp.txt"
  if [ -s "$L/warp_todo.txt" ]; then mrun warp "dartel_warp('$WORK', '$L/warp_todo.txt', '$SPM')"; fi
  mrun tissue_volumes "dartel_tissue_volumes('$WORK', '$LIST', '$SPM')"
  N=$(wc -l < "$LIST")
  [ "$(n_with "$LIST" "$WORK/mni_zext/fov/wfov" _T1w.nii)" -eq "$N" ] || mrun normalise "dartel_normalise('$WORK', '$LIST', '$SPM')"
  py 05_mean_images.py
  py 06_norm_qc.py || true        # QC montages, rated by eye.
  py 07_coverage.py
  py 08_roi_values.py
fi

if [ "$STATS" = 1 ]; then
  py 10_roi_stats.py
  py 11_wm_vbm_setup.py
  bash "$HERE/run_randomise.sh" "$WORK/vbm" "$OUT/vbm/mask_wm02.nii.gz" "$THREADS"
  py 12_wm_vbm_summary.py
  rm -f "$WORK/vbm/smwc2_fwhm8_all.nii"   # The 4D stack is rebuilt by 11_wm_vbm_setup.py when needed.
fi
