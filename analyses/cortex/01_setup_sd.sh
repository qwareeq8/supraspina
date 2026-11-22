#!/usr/bin/env bash
# Scratch SUBJECTS_DIR for the re-registration: a real folder per participant whose surf/, mri/, and mri/transforms/
# hold per-file links into freesurfer.subjects_dir, label/ only the ?h.cortex.label links, and stats/ and scripts/
# real and empty. 02_hemi.sh writes only new file names, so no write can follow a link into the recon.
set -euo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
B=$(cfg freesurfer.subjects_dir)
W=$(cfg work_dir)/cortex
SD=$W/subjects
FREESURFER_HOME=$(cfg freesurfer.home)
mkdir -p "$SD"
[ -e "$SD/fsaverage" ] || ln -s "$FREESURFER_HOME/subjects/fsaverage" "$SD/fsaverage"
while read -r s; do
  [ -n "$s" ] || continue
  src=$B/$s; d=$SD/$s
  [ -d "$d" ] && continue
  mkdir -p "$d/surf" "$d/mri/transforms" "$d/label" "$d/stats" "$d/scripts"
  for f in "$src"/surf/*; do [ -f "$f" ] && ln -s "$f" "$d/surf/$(basename "$f")"; done
  for f in "$src"/mri/*.mgz; do ln -s "$f" "$d/mri/$(basename "$f")"; done
  for f in "$src"/mri/transforms/*; do [ -f "$f" ] && ln -s "$f" "$d/mri/transforms/$(basename "$f")"; done
  for h in lh rh; do ln -s "$src/label/$h.cortex.label" "$d/label/$h.cortex.label"; done
done < "$W/subjects.txt"
echo "Participants in the scratch SUBJECTS_DIR: $(find "$SD" -mindepth 1 -maxdepth 1 -type d | wc -l)"
n_dirlinks=$(find "$SD" -mindepth 2 -type l -xtype d 2>/dev/null | wc -l)
echo "Directory links inside participant folders: $n_dirlinks"
[ "$n_dirlinks" -eq 0 ]
