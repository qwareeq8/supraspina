# shellcheck shell=bash
# Shell access to the private configuration; source this file, then call `cfg KEY`.
# KEY is a dotted key of config.example.yaml, for example `cfg freesurfer.subjects_dir`.
ANALYSES_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYSES_ROOT="$(dirname "$ANALYSES_LIB")"
PYTHON="${PYTHON:-python}"
export ANALYSES_LIB ANALYSES_ROOT PYTHON

cfg() {
  "$PYTHON" -c 'import sys; sys.path.insert(0, sys.argv[1]); import config; print(config.path(sys.argv[2]))' \
    "$ANALYSES_LIB" "$1"
}

# Participant IDs of the analyzed sample, one per line (for loops over participants).
participant_ids() {
  "$PYTHON" -c 'import sys; sys.path.insert(0, sys.argv[1]); import config; print("\n".join(config.participants().participant_id))' \
    "$ANALYSES_LIB"
}
