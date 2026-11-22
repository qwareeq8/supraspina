#!/usr/bin/env bash
# Cross-pipeline agreement and unadjusted volumes; run after the subfields, thalamus, cortex, dartel, and
# dbm_brainstem statistics.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/cfg.sh"
"$PYTHON" "$HERE/medulla_agreement.py"
"$PYTHON" "$HERE/unadjusted_volumes.py"
