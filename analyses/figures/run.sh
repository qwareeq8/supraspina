#!/usr/bin/env bash
# Build the paper's figures after every section has run.
# Usage: run.sh [--process-only | --figures-only]
#   --process-only  write the private Figure 1 arrays only (pipeline and statistics panels)
#   --figures-only  draw the figures and TIFFs from existing arrays and tables
# Needs Poppler (pdftocairo, pdftoppm) on the PATH, and cairosvg and Pillow for the TIFFs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../lib/cfg.sh"
export MPLCONFIGDIR="${MPLCONFIGDIR:-$(mktemp -d)}"

mode="${1:-all}"
case "$mode" in
  all | --process-only | --figures-only) ;;
  *) echo "Usage: run.sh [--process-only | --figures-only]" >&2; exit 2 ;;
esac

if [[ "$mode" != "--figures-only" ]]; then
  "$PYTHON" "$HERE/fig1_pipeline_panels.py"
  "$PYTHON" "$HERE/fig1_stats_panels.py"
fi
if [[ "$mode" != "--process-only" ]]; then
  "$PYTHON" "$HERE/make_figures.py" 1 2 4 6 S1 S2
  "$PYTHON" "$HERE/fig3_atlas_nuclei_tracts.py"
  "$PYTHON" "$HERE/fig5_wholebrain_dbm.py"
  "$PYTHON" "$HERE/render_tiffs.py"
fi
