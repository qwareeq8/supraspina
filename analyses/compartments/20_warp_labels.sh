#!/usr/bin/env bash
# Warp the binary atlas labels to the brainstem DBM template with linear interpolation, which gives the
# partial-volume fraction of each template voxel that a label covers. Allen labels go through the
# ICBM 2009b registration, JHU labels through the FSL MNI152 registration (11_reg_ref.sh). Group-blind.
# Writes labels/<tag>_<name>_{src,tpl}.nii.gz in the section's work folder.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$HERE/../lib/cfg.sh"
C="$(cfg work_dir)/compartments"; O=$C/labels; RR=$C/reg_ref
T="$(cfg work_dir)/dbm_brainstem/template/template_final.nii.gz"
PATH="$(cfg software.ants_bin):$PATH"
export PATH ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=4
"$PYTHON" "$HERE/20_split_labels.py" "$O"
for f in "$O"/allen_*_src.nii.gz; do
  antsApplyTransforms -d 3 -i "$f" -r "$T" -o "${f%_src.nii.gz}_tpl.nii.gz" -n Linear \
    -t "$RR/icbm09bsym_1Warp.nii.gz" -t "$RR/icbm09bsym_0GenericAffine.mat"
done
for f in "$O"/jhu_*_src.nii.gz; do
  antsApplyTransforms -d 3 -i "$f" -r "$T" -o "${f%_src.nii.gz}_tpl.nii.gz" -n Linear \
    -t "$RR/mni152fsl_1Warp.nii.gz" -t "$RR/mni152fsl_0GenericAffine.mat"
done
