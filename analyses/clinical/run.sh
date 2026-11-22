#!/usr/bin/env bash
# Participants, clinical associations, covariation, sensitivity analyses, and clinical stratification.
# --process-only derives years since injury from the private injury and MRI dates (copy the result into the
# participants table); --stats-only runs the group-level statistics, which need the per-participant tables of
# the compartments, thalamus, cortex, subfields, exploratory, and dbm_wholebrain sections.
set -euo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"

mode="${1:-all}"
if [[ "$mode" != "--stats-only" ]]; then
  "$PYTHON" "$HERE/01_years_since_injury.py"
fi
if [[ "$mode" != "--process-only" ]]; then
  for step in 10_table1 20_clinical_model 21_covariation 22_scores 23_consistency 30_stratification \
    24_sensitivity_group; do
    "$PYTHON" "$HERE/$step.py"
  done
fi
