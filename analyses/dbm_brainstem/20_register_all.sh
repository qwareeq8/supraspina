#!/usr/bin/env bash
# Register every analyzed participant to the brainstem template (12_final_one.sh), in parallel
# single-threaded jobs. Writes reg/ in the section's work folder.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$HERE/../lib/cfg.sh"
W="$(cfg work_dir)/dbm_brainstem"
PATH="$(cfg software.ants_bin):$PATH"
NJOBS=$(cfg software.threads)
export PATH ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1
[ -s "$W/template/template_final.nii.gz" ] || { echo "Missing template (run 10_template.sh)." >&2; exit 1; }
participant_ids | xargs -P "$NJOBS" -I{} "$HERE/12_final_one.sh" {} "$W"
n_ok=$(ls "$W"/reg/*_ok 2>/dev/null | wc -l)
n_all=$(participant_ids | wc -l)
echo "Registered $n_ok of $n_all participants."
[ "$n_ok" -eq "$n_all" ]
