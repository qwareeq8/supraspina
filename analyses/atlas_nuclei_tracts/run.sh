#!/usr/bin/env bash
# 7 T atlas nuclei and brainstem tracts on the brainstem DBM template (Fig. 3).
# Processing: warp the atlas labels, build the ROIs, and extract the participant values (needs ANTs, the
# brainstem DBM template and registrations, and the compartment DCN region and MNI152 registration).
# Statistics: 5,000-permutation tests (under a minute).
# Usage: run.sh [--process-only | --stats-only]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-python}"
mode="${1:-all}"
case "$mode" in
  all | --process-only | --stats-only) ;;
  *) echo "Usage: $0 [--process-only | --stats-only]" >&2; exit 2 ;;
esac

if [[ "$mode" != "--stats-only" ]]; then
  "$PYTHON" "$here/warp_labels.py"
  "$PYTHON" "$here/rois.py"
  "$PYTHON" "$here/values.py"
fi
if [[ "$mode" != "--process-only" ]]; then
  "$PYTHON" "$here/stats.py"
fi
