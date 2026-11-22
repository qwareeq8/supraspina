#!/usr/bin/env bash
# Voxelwise TFCE with FSL randomise (default Freedman-Lane, no variance smoothing) for both t contrasts:
# 5,000 permutations as four seeded chunks of 1,250 run in parallel, combined as randomise_parallel
# does (mean of the chunk corrp maps). The unpermuted t map is the same in every chunk.
# Writes stats/SCI_vs_CTRL/{chunk*,tfce_corrp_tstat{1,2},tstat{1,2}}.nii.gz in the section's work folder.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$HERE/../lib/cfg.sh"
ST="$(cfg work_dir)/dbm_brainstem/stats"
FSLDIR=$(cfg software.fsl_dir)
export FSLDIR FSLOUTPUTTYPE=NIFTI_GZ PATH="$FSLDIR/bin:$PATH"
NCH=4; NP=1250; SEED0=20260924
cd "$ST/SCI_vs_CTRL"
Text2Vest design.txt design.mat
Text2Vest contrasts.txt design.con
pids=()
for s in $(seq 1 $NCH); do
  randomise -i logjac_s4 -m ../mask -d design.mat -t design.con -T -n $NP --seed=$((SEED0 + s)) -o "chunk$s" \
    > "chunk$s.log" 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
for k in 1 2; do
  cmd=""
  for s in $(seq 1 $NCH); do cmd="$cmd -add chunk${s}_tfce_corrp_tstat$k"; done
  # shellcheck disable=SC2086
  fslmaths ${cmd# -add} -mul $NP -div $((NCH * NP)) "tfce_corrp_tstat$k"
  imcp "chunk1_tstat$k" "tstat$k"
done
echo "Randomise finished: $ST/SCI_vs_CTRL."
