#!/usr/bin/env bash
# One hemisphere, one surface registration, in the scratch SUBJECTS_DIR (single-threaded; the caller sets nice).
#   b40infl, b40: 1. mris_register to the buckner40 folding atlas (b40infl with -inflated, b40 without);
#                 2. mris_ca_label with the buckner40 DK classifier (2010-03-25) and the Brainnetome classifier;
#                 3. mris_anatomical_stats of both annotations (recon-all flags; never -c, which writes a color
#                    table through a linked path);
#                 4. mri_surf2surf of sulc to fsaverage through the new sphere (input of the screen).
#   default:      the recon's own sphere.reg; Brainnetome labels and stats only (its DK stats are the recon's).
# Outputs have new names only: surf/<h>.sphere.<tag>, label/<h>.{aparc,BN_Atlas}.<tag>.annot,
# stats/<h>.{aparc,BN_Atlas}.<tag>.stats, fsavg/<tag>/<id>.<h>.sulc.mgh. A step whose output exists is skipped.
# Usage: 02_hemi.sh PARTICIPANT_ID HEMI TAG
set -uo pipefail
source "$(dirname "$0")/../lib/cfg.sh"
s=$1; h=$2; tag=$3
W=$(cfg work_dir)/cortex
BN=$(cfg atlases.brainnetome_fs)
FREESURFER_HOME=$(cfg freesurfer.home)
export FREESURFER_HOME FS_NO_HELLO=1 OMP_NUM_THREADS=1 FS_LICENSE=${FS_LICENSE:-$FREESURFER_HOME/license.txt}
set +eu; source "$FREESURFER_HOME/SetUpFreeSurfer.sh" >/dev/null 2>&1; set -u
export SUBJECTS_DIR=$W/subjects
A=$FREESURFER_HOME/average
case $tag in
  b40infl) extra=(-inflated); sphere=sphere.$tag ;;
  b40) extra=(); sphere=sphere.$tag ;;
  default) sphere=sphere.reg ;;
  *) echo "Unknown registration tag: $tag."; exit 2 ;;
esac
d=$SUBJECTS_DIR/$s
F=$W/fsavg/$tag
mkdir -p "$W/logs" "$F"
L=$W/logs/$s.$h.$tag.log
cd "$d/scripts" || exit 1
run() {  # Usage: run OUTPUT cmd... Skip when OUTPUT exists as a regular non-empty file; refuse to write through a link.
  local out=$1; shift
  [ -L "$out" ] && { echo "Link at output path $out, refusing." >> "$L"; return 1; }
  [ -f "$out" ] && [ -s "$out" ] && return 0
  echo "## $(date -Is): $*" >> "$L"
  "$@" >> "$L" 2>&1
}
fail() { echo "FAIL $1 ($h, $tag); see the job log under work_dir/cortex/logs."; exit 1; }
if [ "$tag" != default ]; then
  run "$d/surf/$h.sphere.$tag" mris_register -curv -threads 1 "${extra[@]}" "../surf/$h.sphere" \
    "$A/$h.average.curvature.filled.buckner40.tif" "../surf/$h.sphere.$tag" || fail register
  run "$d/label/$h.aparc.$tag.annot" mris_ca_label -l "../label/$h.cortex.label" -aseg ../mri/aseg.presurf.mgz \
    -seed 1234 "$s" "$h" "../surf/$h.sphere.$tag" "$A/$h.curvature.buckner40.filled.desikan_killiany.2010-03-25.gcs" \
    "../label/$h.aparc.$tag.annot" || fail ca_label_dk
fi
run "$d/label/$h.BN_Atlas.$tag.annot" mris_ca_label -l "../label/$h.cortex.label" -seed 1234 "$s" "$h" \
  "../surf/$h.$sphere" "$BN/$h.BN_Atlas.gcs" "../label/$h.BN_Atlas.$tag.annot" || fail ca_label_bn
annots=(BN_Atlas); [ "$tag" != default ] && annots=(aparc BN_Atlas)
for a in "${annots[@]}"; do
  run "$d/stats/$h.$a.$tag.stats" mris_anatomical_stats -no-th3 -mgz -cortex "../label/$h.cortex.label" \
    -f "../stats/$h.$a.$tag.stats" -b -a "../label/$h.$a.$tag.annot" "$s" "$h" white || fail "stats $a"
done
if [ "$tag" != default ]; then
  run "$F/$s.$h.sulc.mgh" mri_surf2surf --srcsubject "$s" --srchemi "$h" --srcsurfreg "sphere.$tag" \
    --trgsubject fsaverage --trghemi "$h" --trgsurfreg sphere.reg --tval "$F/$s.$h.sulc.mgh" --sval "$d/surf/$h.sulc" \
    --sfmt curv --noreshape || fail s2f_sulc
fi
echo "DONE ($h, $tag)" >> "$L"
