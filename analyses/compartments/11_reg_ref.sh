#!/usr/bin/env bash
# Group-blind registration of an atlas reference crop (moving, MNI-type space) to the brainstem DBM
# template (fixed), in two passes:
#   1. rigid and affine (MI) without a mask, to find where the reference's field of view ends inside the
#      template (the template reaches about 30 mm further down, into the upper cord);
#   2. rigid, affine (MI), and SyN (CC radius 4) from pass 1, with a fixed-image mask of the template
#      voxels covered by the reference crop (its lowest 3 mm removed), so that tissue absent from the
#      reference does not drive the warp.
# Usage: 11_reg_ref.sh <reference_crop> <out_prefix>
# Writes <out_prefix>{0GenericAffine.mat,1Warp.nii.gz,1InverseWarp.nii.gz,Warped.nii.gz,InverseWarped.nii.gz}.
set -euo pipefail
MV=$1; P=$2
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$HERE/../lib/cfg.sh"
F="$(cfg work_dir)/dbm_brainstem/template/template_final.nii.gz"
# Four threads, as in the original runs; ITK results can depend on the thread count.
PATH="$(cfg software.ants_bin):$PATH"
export PATH ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=4
LIN=(-t "Rigid[0.1]" -m "MI[$F,$MV,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox
     -t "Affine[0.1]" -m "MI[$F,$MV,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox)
antsRegistration -d 3 --float 1 -o "[${P}p1_]" -n Linear -w "[0.005,0.995]" -r "[$F,$MV,1]" "${LIN[@]}" > "${P}p1.log" 2>&1
"$PYTHON" - "$MV" "${P}fov_mv.nii.gz" <<'EOF'
import sys

import nibabel as nib
import numpy as np

m = nib.load(sys.argv[1])
a = np.ones(m.shape, np.uint8)
a[:, :, :3] = 0
nib.save(nib.Nifti1Image(a, m.affine), sys.argv[2])
EOF
antsApplyTransforms -d 3 -i "${P}fov_mv.nii.gz" -r "$F" -o "${P}fov_fixed.nii.gz" -n NearestNeighbor -t "${P}p1_0GenericAffine.mat"
antsRegistration -d 3 --float 1 -o "[$P,${P}Warped.nii.gz,${P}InverseWarped.nii.gz]" -n Linear -w "[0.005,0.995]" \
  -r "${P}p1_0GenericAffine.mat" -x "${P}fov_fixed.nii.gz" "${LIN[@]}" \
  -t "SyN[0.1,3,0]" -m "CC[$F,$MV,1,4]" -c "[100x70x50x50,1e-9,10]" -f 6x4x2x1 -s 3x2x1x0vox > "${P}reg.log" 2>&1
