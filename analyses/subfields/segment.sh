#!/usr/bin/env bash
# Brainstem subfields (segment_subregions brainstem) for every participant, NJOBS (default 3) at a time.
# Outputs: <work_dir>/subfields/subregions/<id>/brainstemSsLabels.volumes.txt.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/cfg.sh"
OUT=$(cfg work_dir)/subfields/subregions
mkdir -p "$OUT"
ids=$(participant_ids)
echo "$ids" | xargs -P "${NJOBS:-3}" -I{} bash "$HERE/segment_subregions_one.sh" brainstem {} "$OUT/{}" || true
n=0; miss=0
for sid in $ids; do
  n=$((n + 1))
  [ -s "$OUT/$sid/brainstemSsLabels.volumes.txt" ] || miss=$((miss + 1))
done
echo "Brainstem subfields: $((n - miss)) of $n participants segmented."
[ "$miss" -eq 0 ]
