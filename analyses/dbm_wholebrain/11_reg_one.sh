#!/usr/bin/env bash
# Register one prepared image (moving) to a fixed image with the DBM schedule shared with the brainstem DBM:
# rigid and affine (mutual information, 32 bins), then SyN (step 0.1, update-field regularization 3,
# cross-correlation radius 2), shrink factors 6x4x2x1. Args: fixed moving out_prefix.
# Writes <out_prefix>0GenericAffine.mat, 1Warp, 1InverseWarp, Warped, and reg.log. Skips finished output.
set -euo pipefail
source "$(dirname "$0")/common.sh"
F=$1; M=$2; O=$3
[ -s "${O}Warped.nii.gz" ] && [ -s "${O}0GenericAffine.mat" ] && exit 0
antsRegistration -d 3 --float 1 -v 1 -o "[$O,${O}Warped.nii.gz]" -n Linear -w "[0.005,0.995]" -r "[$F,$M,1]" \
  -t "Rigid[0.1]" -m "MI[$F,$M,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox \
  -t "Affine[0.1]" -m "MI[$F,$M,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox \
  -t "SyN[0.1,3,0]" -m "CC[$F,$M,1,2]" -c "[100x70x50x20,1e-9,10]" -f 6x4x2x1 -s 3x2x1x0vox > "${O}reg.log" 2>&1
