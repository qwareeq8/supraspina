#!/usr/bin/env bash
# Converged Freedman-Lane P values (10,000,008 permutations in 12 streams, seed 20261023).
# Statistics only: reads the per-participant tables of compartments, dbm_brainstem, subfields, dartel,
# atlas_nuclei_tracts, thalamus, and cortex, so run those sections first.
# Run time on 12 processes: about 35 minutes for the thalamic, S1 and M1, and regional set and an
# estimated 15 minutes for the brainstem families. Set N for a shorter trial run (for example N=120000).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-python}"
N="${N:-10000000}"
SEED=20261023

"$PYTHON" "$here/brainstem_families.py" "$N" "$SEED"
"$PYTHON" "$here/thalamus_cortex_families.py" "$N" "$SEED" thal soma region
