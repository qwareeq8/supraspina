#!/usr/bin/env bash
# Unbiased whole-brain template from the dbm_template participants (16 SCI, 16 matched controls; the same 32 as
# the brainstem DBM template), with the update rule of antsMultivariateTemplateConstruction2.sh (ANTs 2.6.5) and
# four iterations:
#   it0: rigid (MI) registration of each prepared image to the reference participant's image padded by 10 mm
#        (pose and grid reference only), normalized average; the grid is then fixed once (04_grid.py) for the
#        later iterations and the final registrations;
#   it1 to it4: register each image to the current template (11_reg_one.sh); normalized average and Laplacian
#        sharpening; mean forward warp times -0.25; average affine without its rigid part; the inverse average
#        affine and four times the scaled warp applied to the sharpened average.
# Per-participant warps of an iteration are deleted once used. Resumable: finished steps are skipped.
set -euo pipefail
source "$(dirname "$0")/common.sh"
T=$W/template; LOG=$W/logs/template.log; NIT=4
say() { echo "$(date -Is) $*" >> "$LOG"; }
mkdir -p "$T/it0"
mapfile -t ids < <(template_ids)
REF_ID=$(cfg dbm_wholebrain.template_reference)
printf '%s\n' "${ids[@]}" | grep -qxF "$REF_ID" || { echo "The template reference is not a template participant." >&2; exit 1; }
say "start; template participants: ${#ids[@]}"
ref=$T/ref_pad.nii.gz
[ -s "$ref" ] || "$PYTHON" "$HERE/03_refpad.py" "$W/prep/${REF_ID}_T1.nii.gz" "$ref" 10 >> "$LOG" 2>&1
t0=$(date +%s)

rigid_one() {
  local o=$T/it0/${1}_ m=$W/prep/${1}_T1.nii.gz
  [ -s "${o}Warped.nii.gz" ] && return 0
  antsRegistration -d 3 --float 1 -o "[$o,${o}Warped.nii.gz]" -n Linear -r "[$ref,$m,1]" \
    -t "Rigid[0.1]" -m "MI[$ref,$m,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox \
    > "${o}reg.log" 2>&1
}
export -f rigid_one
export T ref

files() {  # Usage: files <dir> <suffix>. Print one path per template participant.
  local s; for s in "${ids[@]}"; do echo "$1/${s}$2"; done
}

if [ ! -s "$T/template_it0.nii.gz" ]; then
  printf '%s\n' "${ids[@]}" | xargs -P "$NJ" -I{} bash -c 'rigid_one "$1"' _ {}
  mapfile -t warped < <(files "$T/it0" _Warped.nii.gz)
  AverageImages 3 "$T/it0/avg_pad.nii.gz" 2 "${warped[@]}" >> "$LOG" 2>&1
  "$PYTHON" "$HERE/04_grid.py" "$T/it0/avg_pad.nii.gz" "$T/template_it0.nii.gz" >> "$LOG" 2>&1
  say "it0 done sec=$(( $(date +%s) - t0 ))"
fi

prev=$T/template_it0.nii.gz
for it in $(seq 1 $NIT); do
  out=$T/template_it$it.nii.gz
  if [ -s "$out" ]; then prev=$out; continue; fi
  t1=$(date +%s); d=$T/it$it; mkdir -p "$d"
  printf '%s\n' "${ids[@]}" | xargs -P "$NJ" -I{} bash "$HERE/11_reg_one.sh" "$prev" "$W/prep/{}_T1.nii.gz" "$d/{}_" || true
  mapfile -t warped < <(files "$d" _Warped.nii.gz)
  n=0; for f in "${warped[@]}"; do [ -s "$f" ] && n=$((n + 1)); done
  [ "$n" -eq "${#ids[@]}" ] || { say "it$it: only $n warped images; stop"; exit 1; }
  mapfile -t warps < <(files "$d" _1Warp.nii.gz)
  mapfile -t affs < <(files "$d" _0GenericAffine.mat)
  AverageImages 3 "$d/avg.nii.gz" 2 "${warped[@]}" >> "$LOG" 2>&1
  ImageMath 3 "$d/avg_sharp.nii.gz" Sharpen "$d/avg.nii.gz" 0 >> "$LOG" 2>&1
  AverageImages 3 "$d/avgwarp.nii.gz" 0 "${warps[@]}" >> "$LOG" 2>&1
  MultiplyImages 3 "$d/avgwarp.nii.gz" -0.25 "$d/avgwarp_scaled.nii.gz" >> "$LOG" 2>&1
  AverageAffineTransformNoRigid 3 "$d/avgaff.mat" "${affs[@]}" >> "$LOG" 2>&1
  antsApplyTransforms -d 3 -e physical-vector -i "$d/avgwarp_scaled.nii.gz" -o "$d/avgwarp_scaled_aff.nii.gz" \
    -t "[$d/avgaff.mat,1]" -r "$d/avg_sharp.nii.gz" >> "$LOG" 2>&1
  w=$d/avgwarp_scaled_aff.nii.gz
  antsApplyTransforms -d 3 --float 1 -i "$d/avg_sharp.nii.gz" -o "$out.tmp.nii.gz" \
    -t "[$d/avgaff.mat,1]" -t "$w" -t "$w" -t "$w" -t "$w" -r "$d/avg_sharp.nii.gz" >> "$LOG" 2>&1
  mv "$out.tmp.nii.gz" "$out"
  rm -f "$d"/*_1Warp.nii.gz "$d"/*_1InverseWarp.nii.gz "$d/avgwarp.nii.gz"
  say "it$it done sec=$(( $(date +%s) - t1 ))"
  prev=$out
done
cp "$prev" "$T/template_final.nii.gz"
say "template done total sec=$(( $(date +%s) - t0 ))"
touch "$T/TEMPLATE_DONE"
