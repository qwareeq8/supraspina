#!/usr/bin/env bash
# Thalamic nuclei (segment_subregions thalamus, probabilistic atlas of Iglesias et al. 2018) for every participant,
# NJOBS (default 3) at a time. Outputs: <work_dir>/thalamus/out/<id>/ThalamicNuclei.{volumes.txt,FSvoxelSpace.mgz,mgz}.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/cfg.sh"
OUT=$(cfg work_dir)/thalamus/out
mkdir -p "$OUT"
ids=$(participant_ids)
echo "$ids" | xargs -P "${NJOBS:-3}" -I{} bash "$HERE/../subfields/segment_subregions_one.sh" thalamus {} "$OUT/{}" || true
n=0; miss=0
for sid in $ids; do
  n=$((n + 1))
  [ -s "$OUT/$sid/ThalamicNuclei.volumes.txt" ] || miss=$((miss + 1))
done
echo "Thalamic nuclei: $((n - miss)) of $n participants segmented."
[ "$miss" -eq 0 ]
