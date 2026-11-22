# shellcheck shell=bash
# Settings shared by the whole-brain DBM shell steps; source this file.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/cfg.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HERE
# Child processes inherit the exported values, so the configuration is read once per run.
if [ -z "${DBM_WB_READY:-}" ]; then
  W="$(cfg work_dir)/dbm_wholebrain"
  NJ="${NJ:-$(cfg software.threads)}"
  PATH="$(cfg software.ants_bin):$PATH"
  # Each registration runs single-threaded; NJ of them run in parallel.
  ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1
  DBM_WB_READY=1
  export W NJ PATH ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS DBM_WB_READY
  mkdir -p "$W/logs"
fi

# Participant IDs of the template subset (dbm_template = 1), one per line.
template_ids() {
  "$PYTHON" -c 'import sys; sys.path.insert(0, sys.argv[1]); import config; d = config.participants(); print("\n".join(d.participant_id[d.dbm_template.fillna(0).astype(int) == 1]))' \
    "$ANALYSES_LIB"
}
