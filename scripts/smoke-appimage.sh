#!/usr/bin/env bash
#
# Verify the exact Linux x86_64 AppImage payload, then launch that same artifact
# through AppImage's supported extract-and-run fallback.

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Run: smoke-appimage.sh <supraspina.AppImage>." >&2
  exit 2
fi

appimage="$(realpath "$1")"
readonly appimage
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_dir
temporary_dir="$(mktemp -d)"
readonly temporary_dir
cleanup() {
  rm -rf -- "${temporary_dir}"
}
trap cleanup EXIT

test -f "${appimage}"
test -x "${appimage}"
file "${appimage}" | grep -Eq 'ELF 64-bit.*x86-64'

(
  cd "${temporary_dir}"
  timeout --signal=TERM --kill-after=5s 60s \
    "${appimage}" --appimage-extract >/dev/null
)
readonly application_root="${temporary_dir}/squashfs-root"
readonly resources_path="${application_root}/resources"
test -x "${application_root}/supraspina"
file "${application_root}/supraspina" | grep -Eq 'ELF 64-bit.*x86-64'

node "${project_dir}/scripts/verify-packaged-application.mjs" \
  --application-root "${application_root}" \
  --resources "${resources_path}" \
  --target linux-x86_64

# Inspect this artifact's launcher metadata, icons, and sandbox policy.
node "${project_dir}/scripts/inspect-linux-packages.mjs" --appimage "${appimage}"

# Treat this as proof of the exact AppImage's extracted payload and launch
# handoff. Do not treat it as a desktop FUSE-mount or double-click test.
timeout --signal=TERM --kill-after=10s 130s \
  env APPIMAGE_EXTRACT_AND_RUN=1 \
  xvfb-run -a npm --prefix "${project_dir}" run smoke:package -- \
  --executable "${appimage}" --type appimage
