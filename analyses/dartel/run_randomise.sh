#!/usr/bin/env bash
# FSL randomise with TFCE for the white matter contrast CTRL - SCI (smaller in SCI): 10 chunks of 500
# permutations with seeds 1001 to 1010 (5,000 in all; Freedman-Lane, no variance smoothing), pooled by
# 12_wm_vbm_summary.py. -N writes each chunk's null distribution of the maximum TFCE, -P its permutation
# vectors, and -R the raw statistic maps. Finished chunks are skipped.
#   run_randomise.sh VBM_DIR MASK [JOBS]
set -euo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
O=$1
MASK=$2
JOBS=${3:-1}
FSLDIR=$(cfg software.fsl_dir)
export FSLDIR FSLOUTPUTTYPE=NIFTI_GZ PATH="$FSLDIR/bin:$PATH"
R=$O/rand
mkdir -p "$R"

chunk() {
  local k=$1
  [ -f "$R/chunk${k}_c1.done" ] && return 0
  randomise -i "$O/smwc2_fwhm8_all.nii" -o "$R/chunk${k}_c1" -d "$O/design.mat" -t "$O/c1.con" \
    -m "$MASK" -T -n 500 --seed=$((1000 + k)) -N -P -R > "$R/chunk${k}_c1.log" 2>&1
  touch "$R/chunk${k}_c1.done"
}

for k in 1 2 3 4 5 6 7 8 9 10; do
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n || true; done
  chunk "$k" &
done
wait
n=$(find "$R" -maxdepth 1 -name 'chunk*_c1.done' | wc -l)
echo "Randomise: $n of 10 chunks done."
[ "$n" -eq 10 ]
