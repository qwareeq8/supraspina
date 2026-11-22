#!/usr/bin/env bash
# Unbiased brainstem template from the participants flagged dbm_template (SCI and matched controls),
# following the update rule of antsMultivariateTemplateConstruction2.sh (ANTs 2.6.5).
#   Iteration 0: rigid (MI) alignment of each crop to the padded reference crop, which sets only the
#     grid and pose, then the normalized average.
#   Iterations 1 to 3: registration of each crop to the current template (11_reg_one.sh), then the
#     normalized average of the warped crops with Laplacian sharpening, the mean forward warp scaled
#     by -0.25, the mean affine without its rigid part, and [mean affine]^-1 plus 4 x the scaled warp
#     applied to the sharpened average.
# Iteration 1 runs on the padded grid (+12 mm); its template is then cropped by 9 mm on every side
# (the participant crop + 3 mm), and later iterations and all final registrations use that grid,
# which halves the registration time. Writes template/ in the section's work folder.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$HERE/../lib/cfg.sh"
W="$(cfg work_dir)/dbm_brainstem"; T=$W/template
PATH="$(cfg software.ants_bin):$PATH"
NJOBS=$(cfg software.threads)
# One thread per registration, as in the original runs; ITK results can depend on the thread count.
export PATH ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 W T HERE
NIT=3
mapfile -t ids < <("$PYTHON" -c 'import sys; sys.path.insert(0, sys.argv[1]); import config
d = config.participants(); print("\n".join(d.participant_id[d.dbm_template == 1]))' "$ANALYSES_LIB")
[ "${#ids[@]}" -eq 32 ] || { echo "Expected 32 template participants, found ${#ids[@]}." >&2; exit 1; }
ref=$T/ref_pad.nii.gz
[ -s "$ref" ] || { echo "Missing $ref (run 02_crop.py)." >&2; exit 1; }
export ref

rigid_one() {
  local o=$T/it0/${1}_ m=$W/crop/${1}_T1.nii.gz
  [ -s "${o}Warped.nii.gz" ] && return 0
  antsRegistration -d 3 --float 1 -o "[$o,${o}Warped.nii.gz]" -n Linear -r "[$ref,$m,1]" \
    -t "Rigid[0.1]" -m "MI[$ref,$m,1,32,Regular,0.25]" -c "[1000x500x250x0,1e-6,10]" -f 6x4x2x1 -s 4x2x1x0vox \
    > "${o}reg.log" 2>&1
}
export -f rigid_one

files() {  # Arguments: $1 prefix, $2 suffix. Print one path per template participant, in ID order.
  local s
  for s in "${ids[@]}"; do printf '%s\n' "$1$s$2"; done
}

update() {  # Arguments: $1 iteration folder, $2 output template.
  local d=$1 out=$2 w warped warps affs
  mapfile -t warped < <(files "$d/" _Warped.nii.gz)
  mapfile -t warps < <(files "$d/" _1Warp.nii.gz)
  mapfile -t affs < <(files "$d/" _0GenericAffine.mat)
  AverageImages 3 "$d/avg.nii.gz" 2 "${warped[@]}" > /dev/null
  ImageMath 3 "$d/avg_sharp.nii.gz" Sharpen "$d/avg.nii.gz" 0
  AverageImages 3 "$d/avgwarp.nii.gz" 0 "${warps[@]}" > /dev/null
  MultiplyImages 3 "$d/avgwarp.nii.gz" -0.25 "$d/avgwarp_scaled.nii.gz"
  AverageAffineTransformNoRigid 3 "$d/avgaff.mat" "${affs[@]}"
  antsApplyTransforms -d 3 -e physical-vector -i "$d/avgwarp_scaled.nii.gz" -o "$d/avgwarp_scaled_aff.nii.gz" \
    -t "[$d/avgaff.mat,1]" -r "$d/avg_sharp.nii.gz"
  w=$d/avgwarp_scaled_aff.nii.gz
  antsApplyTransforms -d 3 --float 1 -i "$d/avg_sharp.nii.gz" -o "$out" -t "[$d/avgaff.mat,1]" \
    -t "$w" -t "$w" -t "$w" -t "$w" -r "$d/avg_sharp.nii.gz"
}

mkdir -p "$T/it0"
printf '%s\n' "${ids[@]}" | xargs -P "$NJOBS" -I{} bash -c 'rigid_one "$1"' _ {}
mapfile -t warped0 < <(files "$T/it0/" _Warped.nii.gz)
AverageImages 3 "$T/template_it0.nii.gz" 2 "${warped0[@]}" > /dev/null
prev=$T/template_it0.nii.gz
for it in $(seq 1 $NIT); do
  d=$T/it$it; mkdir -p "$d"
  printf '%s\n' "${ids[@]}" | xargs -P "$NJOBS" -I{} \
    "$HERE/11_reg_one.sh" "$prev" "$W/crop/{}_T1.nii.gz" "$d/{}_"
  n=$(ls "$d"/*_Warped.nii.gz | wc -l)
  [ "$n" -eq 32 ] || { echo "Iteration $it: only $n warped images." >&2; exit 1; }
  update "$d" "$T/template_it$it.nii.gz"
  prev=$T/template_it$it.nii.gz
  if [ "$it" -eq 1 ]; then
    "$PYTHON" "$HERE/04_crop_template.py" "$prev" "$T/template_it1_crop.nii.gz" 9
    prev=$T/template_it1_crop.nii.gz
  fi
done
cp "$prev" "$T/template_final.nii.gz"
echo "Template written: $T/template_final.nii.gz"
