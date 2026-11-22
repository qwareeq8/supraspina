#!/usr/bin/env bash
# Group-blind rigid + affine (MI) registration of the FSL MNI152 1 mm brain to the study template, for approximate
# MNI coordinates of cluster peaks and figure slices; 24_mni_affine.py turns it into a 4 x 4 matrix and checks it
# against MNI coordinate maps resampled into the template. Writes mni/ only.
set -euo pipefail
source "$(dirname "$0")/common.sh"
T=$W/template/template_final.nii.gz; O=$W/mni; P=$O/mni_aff_
[ -e "$W/template/TEMPLATE_DONE" ] || { echo "The template is not finished (10_template.sh)." >&2; exit 1; }
M=$(cfg software.fsl_dir)/data/standard/MNI152_T1_1mm_brain.nii.gz
mkdir -p "$O"
if [ ! -s "${P}Warped.nii.gz" ]; then
  antsRegistration -d 3 --float 1 -o "[$P,${P}Warped.nii.gz]" -n Linear -w "[0.005,0.995]" -r "[$T,$M,1]" \
    -t "Rigid[0.1]" -m "MI[$T,$M,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox \
    -t "Affine[0.1]" -m "MI[$T,$M,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox \
    > "${P}reg.log" 2>&1
fi
"$PYTHON" "$HERE/24_mni_affine.py" coords "$M"
for ax in x y z; do
  antsApplyTransforms -d 3 -i "$O/mni${ax}_mni.nii.gz" -r "$T" -o "$O/mni${ax}_aff.nii.gz" -n Linear \
    -t "${P}0GenericAffine.mat"
done
"$PYTHON" "$HERE/24_mni_affine.py" fit
rm -f "$O"/mni?_mni.nii.gz
