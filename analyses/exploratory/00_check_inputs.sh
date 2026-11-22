#!/usr/bin/env bash
# Checks that every participant's recon holds the inputs of the exploratory measures: mri/nu.mgz (hypothalamic
# subunits) and mri/orig.mgz (CerebNet). Exit 1 if anything is missing.
set -euo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
SD=$(cfg freesurfer.subjects_dir)
miss=0; n=0
for s in $(participant_ids); do
  n=$((n + 1))
  for f in mri/nu.mgz mri/orig.mgz; do [ -f "$SD/$s/$f" ] || miss=$((miss + 1)); done
done
echo "Participants $n; missing input files $miss."
[ "$miss" -eq 0 ]
