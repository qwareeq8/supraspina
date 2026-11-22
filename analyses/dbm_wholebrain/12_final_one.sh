#!/usr/bin/env bash
# Final registration of one participant to the study template, then the log-Jacobian of the SyN warp and the
# participant's aparc+aseg and subfield labels warped to the template (GenericLabel). The affine's log|det| is
# added in 22_roi.py. Arg: participant_id. Writes reg/ only. Resumable.
set -euo pipefail
source "$(dirname "$0")/common.sh"
SID=$1
T=$W/template/template_final.nii.gz; O=$W/reg/${SID}_
mkdir -p "$W/reg"
[ -e "${O}ok" ] && exit 0
bash "$HERE/11_reg_one.sh" "$T" "$W/prep/${SID}_T1.nii.gz" "$O"
[ -s "${O}logjac_warp.nii.gz" ] || CreateJacobianDeterminantImage 3 "${O}1Warp.nii.gz" "${O}logjac_warp.nii.gz" 1 1 > /dev/null
for l in aparc bsl; do
  [ -s "${O}${l}_w.nii.gz" ] || antsApplyTransforms -d 3 -i "$W/prep/${SID}_${l}.nii.gz" -r "$T" -o "${O}${l}_w.nii.gz" \
    -n GenericLabel -u short -t "${O}1Warp.nii.gz" -t "${O}0GenericAffine.mat"
done
touch "${O}ok"
