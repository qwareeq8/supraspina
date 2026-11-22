#!/usr/bin/env bash
# FastSurfer 2.5.4 (Apptainer image software.fastsurfer_sif) --seg_only: the VINN aseg+DKT segmentation, then
# CerebNet cerebellar lobules; HypVINN and corpus callosum off. Input: the FreeSurfer 8.2.0 conformed mri/orig.mgz.
# GPU (DEVICE, default cuda), 3 CPU threads. Participants with a CerebNet stats file are skipped.
# Output: <work_dir>/exploratory/fastsurfer/<id>.
set -uo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
SD=$(cfg freesurfer.subjects_dir)
SIF=$(cfg software.fastsurfer_sif)
FREESURFER_HOME=$(cfg freesurfer.home)
LIC=${FS_LICENSE:-$FREESURFER_HOME/license.txt}
FO=$(cfg work_dir)/exploratory/fastsurfer
mkdir -p "$FO"
n=0; fail=0
for s in $(participant_ids); do
  [ -f "$FO/$s/stats/cerebellum.CerebNet.stats" ] && continue
  [ -f "$SD/$s/mri/orig.mgz" ] || { fail=$((fail + 1)); continue; }
  n=$((n + 1))
  nice -n 15 apptainer exec --nv --no-home -B "$SD/$s/mri:/input:ro" -B "$FO:/sd" -B "$LIC:/fs_license.txt:ro" \
    "$SIF" /fastsurfer/run_fastsurfer.sh --t1 /input/orig.mgz --sid "$s" --sd /sd --seg_only --no_hypothal --no_cc \
    --device "${DEVICE:-cuda}" --threads 3 --fs_license /fs_license.txt > "$FO/$s.log" 2>&1 || fail=$((fail + 1))
done
echo "CerebNet: $n run; $fail failed or without orig.mgz."
[ "$fail" -eq 0 ]
