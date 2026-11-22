#!/usr/bin/env bash
# FreeSurfer 8.2.0 mri_segment_hypothalamic_subunits (FreeSurfer mode, CPU, 3 threads) for participants without the
# stats file, in chunks of 8 (the TensorFlow process grows by about 1 GB per participant). The tool reads only
# mri/nu.mgz; it runs in a mirror SUBJECTS_DIR (<work_dir>/exploratory/hypo_sd: real mri/ and stats/, nu.mgz a
# link) so the recons stay unmodified.
set -uo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
FREESURFER_HOME=$(cfg freesurfer.home)
export FREESURFER_HOME FS_LICENSE=${FS_LICENSE:-$FREESURFER_HOME/license.txt}
set +eu; source "$FREESURFER_HOME/SetUpFreeSurfer.sh" >/dev/null 2>&1; set -u
SD=$(cfg freesurfer.subjects_dir)
HSD=$(cfg work_dir)/exploratory/hypo_sd
st=stats/hypothalamic_subunits_volumes.v1.stats
todo=""
for s in $(participant_ids); do
  [ -f "$SD/$s/mri/nu.mgz" ] && [ ! -f "$SD/$s/$st" ] && [ ! -f "$HSD/$s/$st" ] && todo="$todo $s"
done
[ -z "$todo" ] && { echo "Hypothalamus: nothing to do."; exit 0; }
for s in $todo; do mkdir -p "$HSD/$s/mri" "$HSD/$s/stats"; ln -sfn "$SD/$s/mri/nu.mgz" "$HSD/$s/mri/nu.mgz"; done
echo "$todo" | xargs -n 8 | while read -r chunk; do
  # shellcheck disable=SC2086  # one argument per participant
  CUDA_VISIBLE_DEVICES='' nice -n 15 mri_segment_hypothalamic_subunits --s $chunk --sd "$HSD" --threads 3 --cpu
  echo "Chunk rc=$? $(date -Is)."
done
