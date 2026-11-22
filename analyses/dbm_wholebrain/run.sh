#!/usr/bin/env bash
# Whole-brain DBM: processing (preparation, template, registrations, ROI values, QC overlays, MNI affine), then
# statistics (design, randomise, clusters, cluster means, ROI estimates). Usage: run.sh [--process-only | --stats-only]
# Between the two, review the QC overlays (qc_png/, flags in reg_flags.csv) and list any failed registration in the
# file named by qc.dbm_wholebrain_registration_exclusions (empty in the paper).
# The template and the registrations take days of CPU time; randomise takes hours.
set -euo pipefail
cd "$(dirname "$0")"
source ./common.sh
mode=${1:-all}
if [ "$mode" != --stats-only ]; then
  "$PYTHON" 01_fov_check.py
  "$PYTHON" 02_prep.py
  bash 10_template.sh
  bash 20_register_all.sh
  "$PYTHON" 22_roi.py
  "$PYTHON" 22b_flags.py
  "$PYTHON" 23_qc_png.py
  bash 24_mni.sh
fi
if [ "$mode" != --process-only ]; then
  "$PYTHON" 25_design.py
  bash 26_randomise.sh
  "$PYTHON" 27_voxel_summary.py
  "$PYTHON" 27b_cluster_parts.py
  "$PYTHON" 28_cluster_means.py
  "$PYTHON" 29_roi_agreement.py
fi
