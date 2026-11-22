#!/usr/bin/env bash
# Runs every section in dependency order.
# Usage: run_all.sh --process-only | --stats-only
#   --process-only  participant-level processing (days on one workstation). Two manual reviews follow it
#                   before the statistics: the thalamic montage ratings (qc.thalamus_ratings) and the
#                   review of flagged cortical registrations (qc.cortical_adjudication).
#   --stats-only    group statistics, converged permutations, and figures.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
mode=${1:-}
PROCESS="subfields thalamus cortex exploratory dartel dbm_brainstem compartments atlas_nuclei_tracts dbm_wholebrain"
STATS="$PROCESS"
case $mode in
  --process-only)
    for s in $PROCESS; do echo "== $s"; bash "$HERE/$s/run.sh" --process-only; done
    bash "$HERE/clinical/run.sh" --process-only
    ;;
  --stats-only)
    for s in $STATS; do echo "== $s"; bash "$HERE/$s/run.sh" --stats-only; done
    bash "$HERE/summary/run.sh"
    bash "$HERE/clinical/run.sh" --stats-only
    bash "$HERE/permutations/run.sh"
    bash "$HERE/figures/run.sh"
    ;;
  *) echo "Usage: run_all.sh --process-only | --stats-only" >&2; exit 2 ;;
esac
