#!/usr/bin/env bash
# Voxelwise TFCE with FSL randomise (default Freedman-Lane, no variance smoothing), both t contrasts, 5,000
# permutations run as 8 seeded chunks of 625 in parallel. The chunk corrp maps are averaged as randomise_parallel
# does; 27_voxel_summary.py instead recovers the exact permutation counts per chunk (stats_lib.pfwe_exact).
# The unpermuted t is identical in every chunk. Resumable: finished chunks are skipped. Writes stats/SCI_vs_CTRL/.
set -euo pipefail
source "$(dirname "$0")/common.sh"
FSLDIR=$(cfg software.fsl_dir); FSLOUTPUTTYPE=NIFTI_GZ; PATH=$FSLDIR/bin:$PATH
export FSLDIR FSLOUTPUTTYPE PATH
NCH=8; NP=625; SEED0=20260930
cd "$W/stats/SCI_vs_CTRL"
Text2Vest design.txt design.mat
Text2Vest contrasts.txt design.con
t0=$(date +%s); pids=()
for s in $(seq 1 $NCH); do
  [ -e "chunk${s}_tfce_corrp_tstat2.nii.gz" ] && continue
  randomise -i logjac_s4 -m ../mask -d design.mat -t design.con -T -n $NP --seed=$((SEED0 + s)) -o "chunk$s" \
    > "chunk$s.log" 2>&1 &
  pids+=($!)
done
for p in ${pids[@]+"${pids[@]}"}; do wait "$p"; done
for k in 1 2; do
  args=("chunk1_tfce_corrp_tstat$k")
  for s in $(seq 2 $NCH); do args+=(-add "chunk${s}_tfce_corrp_tstat$k"); done
  fslmaths "${args[@]}" -div $NCH "tfce_corrp_tstat$k"
  imcp chunk1_tstat$k tstat$k
done
echo "$(date -Is) randomise sec=$(( $(date +%s) - t0 ))" >> "$W/logs/randomise.log"
