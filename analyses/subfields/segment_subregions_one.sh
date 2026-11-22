#!/usr/bin/env bash
# FreeSurfer 8.2.0 segment_subregions for one participant: brainstem subfields or thalamic nuclei.
# The fspython of FreeSurfer 8.2.0 is Python 3.8, but the gems bindings of samseg are built for CPython 3.12, so
# the same samseg code runs in a uv-managed Python 3.12 environment, single-threaded, from the folder named by
# software.samseg_python. Reads <subjects_dir>/<id> without writing to it; all outputs go to OUT_DIR.
# A participant whose volumes file already exists is skipped.
# Usage: segment_subregions_one.sh brainstem|thalamus PARTICIPANT_ID OUT_DIR
set -euo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
struct=$1; sid=$2; out=$3
case $struct in
  brainstem) vol=brainstemSsLabels.volumes.txt ;;
  thalamus) vol=ThalamicNuclei.volumes.txt ;;
  *) echo "Unknown structure: $struct." >&2; exit 2 ;;
esac
[ -s "$out/$vol" ] && exit 0
SD=$(cfg freesurfer.subjects_dir)
[ -d "$SD/$sid/mri" ] || { echo "A participant has no FreeSurfer folder in freesurfer.subjects_dir." >&2; exit 2; }
mkdir -p "$out"
FREESURFER_HOME=$(cfg freesurfer.home)
SAMSEG=$(cfg software.samseg_python)
export FREESURFER_HOME FS_LICENSE=${FS_LICENSE:-$FREESURFER_HOME/license.txt}
set +eu  # SetUpFreeSurfer.sh reads unset variables.
source "$FREESURFER_HOME/SetUpFreeSurfer.sh" >/dev/null 2>&1
set -eu
export SUBJECTS_DIR=$SD PYTHONPATH=$SAMSEG OMP_NUM_THREADS=1 ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1
rc=0
nice -n 15 uv run --no-project --python 3.12 --with 'numpy<2' --with 'scipy<1.14' --with nibabel --with surfa \
  --with numba python -c \
  'import sys; from samseg.cli.segment_subregions import main; sys.argv = ["segment_subregions"] + sys.argv[1:]; main()' \
  "$struct" --cross "$sid" --sd "$SD" --out-dir "$out" --temp-dir "$out/tmp" --threads 1 > "$out/log.txt" 2>&1 || rc=$?
rm -rf "$out/tmp"
exit $rc
