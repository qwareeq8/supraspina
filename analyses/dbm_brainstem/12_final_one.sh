#!/usr/bin/env bash
# Final registration of one participant's crop to the brainstem template, the log-Jacobian of the SyN
# warp (geometric), and the participant's subfield and aseg labels warped to the template
# (GenericLabel). The log|det| of the affine is added in 22_roi.py. Expects ANTs on PATH.
# Usage: 12_final_one.sh <participant_id> <section_work_dir>
# Writes reg/<participant_id>_{0GenericAffine.mat,1Warp.nii.gz,1InverseWarp.nii.gz,Warped.nii.gz,
# logjac_warp.nii.gz,bsl_w.nii.gz,aseg_w.nii.gz,ok}.
set -euo pipefail
SID=$1; W=$2
HERE=$(cd "$(dirname "$0")" && pwd)
T=$W/template/template_final.nii.gz; O=$W/reg/${SID}_
mkdir -p "$W/reg"
"$HERE/11_reg_one.sh" "$T" "$W/crop/${SID}_T1.nii.gz" "$O"
[ -s "${O}logjac_warp.nii.gz" ] || CreateJacobianDeterminantImage 3 "${O}1Warp.nii.gz" "${O}logjac_warp.nii.gz" 1 1 > /dev/null
for l in bsl aseg; do
  [ -s "${O}${l}_w.nii.gz" ] || antsApplyTransforms -d 3 -i "$W/crop/${SID}_${l}.nii.gz" -r "$T" -o "${O}${l}_w.nii.gz" \
    -n GenericLabel -t "${O}1Warp.nii.gz" -t "${O}0GenericAffine.mat"
done
touch "${O}ok"
