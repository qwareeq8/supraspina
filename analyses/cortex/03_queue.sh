#!/usr/bin/env bash
# Run 02_hemi.sh over a job list ("participant_id hemi" per line) with at most NJOBS (default 3) single-threaded
# jobs at nice 15. Usage: 03_queue.sh JOBLIST TAG
set -uo pipefail
list=$1
HEMI_SCRIPT="$(cd "$(dirname "$0")" && pwd)/02_hemi.sh"
TAG=$2
export HEMI_SCRIPT TAG
[ -s "$list" ] || { echo "No $TAG jobs."; exit 0; }
echo "Queue $TAG: $(wc -l < "$list") jobs, ${NJOBS:-3} in parallel, started $(date -Is)."
# The xargs call passes the two fields of a line as $0 and $1 of the inner shell.
xargs -P "${NJOBS:-3}" -L 1 bash -c 'nice -n 15 bash "$HEMI_SCRIPT" "$0" "$1" "$TAG"' < "$list" || true
echo "Queue $TAG ended $(date -Is)."
