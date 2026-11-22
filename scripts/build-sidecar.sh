#!/usr/bin/env bash
#
# Freeze the Python orchestration sidecar into a self-contained directory bundle
# for the current OS, with redistribution-approved pipeline support assets.
#
# Write the output to resources/sidecar/supraspina-sidecar (or .exe on Windows) with
# its supraspina-runtime directory. Stage redistribution-approved assets under
# resources/ inside that runtime directory, and let supraspina_sidecar.resources
# resolve them through sys._MEIPASS. Exclude scientific upstream files whose
# redistribution terms remain unresolved, and obtain them only through the
# explicit, checksum-pinned operator acquisition flow. Provision the PyBrainAge
# model explicitly. Let electron-builder supply the separately verified platform
# micromamba executable.
#
# Then ship this bundle as an extraResource through the electron-builder
# configuration (see electron-builder.yml: resources/sidecar -> sidecar). Run
# this script before electron-builder during a local package build.

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly app_dir
readonly sidecar_dir="${app_dir}/sidecar"
readonly resources_dir="${app_dir}/resources"
readonly out_dir="${resources_dir}/sidecar"
staging_dir="$(mktemp -d)"
readonly staging_dir
cleanup_staging() {
  rm -rf -- "${staging_dir}"
}
trap cleanup_staging EXIT

# Refuse every ignored output owned by this recipe. Reusing these paths can
# silently retain a stale launcher, PyInstaller intermediate, or runtime file.
readonly owned_output_paths=(
  "${sidecar_dir}/build"
  "${sidecar_dir}/dist"
  "${out_dir}"
)
for output_path in "${owned_output_paths[@]}"; do
  if [[ -e "${output_path}" || -L "${output_path}" ]]; then
    echo "build-sidecar: Remove the prior ignored output before building: ${output_path}." >&2
    exit 1
  fi
done
# Refuse ignored release metadata that describes another source. Packaging
# copies build/release-metadata into every package, and the directory outlives
# the release build that generated it.
node "${app_dir}/scripts/release-package-manifest.mjs" check-staged

# Set an explicit interpreter to support a clean, exact release venv without
# disturbing a developer's ordinary sidecar venv. Otherwise, prefer the sidecar
# venv, then a Windows venv layout, and then PATH.
python_bin="${SUPRASPINA_BUILD_PYTHON:-}"
if [[ -n "${python_bin}" && ! -x "${python_bin}" ]]; then
  echo "build-sidecar: Set SUPRASPINA_BUILD_PYTHON to an executable interpreter." >&2
  exit 1
fi
if [[ -z "${python_bin}" ]]; then
  for candidate in \
    "${sidecar_dir}/.venv/bin/python" \
    "${sidecar_dir}/.venv/Scripts/python.exe" \
    "$(command -v python3 || true)" \
    "$(command -v python || true)"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      python_bin="${candidate}"
      break
    fi
  done
fi
if [[ -z "${python_bin}" ]]; then
  echo "build-sidecar: Install Python or set" \
    "SUPRASPINA_BUILD_PYTHON to an executable interpreter." >&2
  exit 1
fi

# Anchor the selected interpreter before changing into the sidecar directory.
python_dir="$(cd "$(dirname "${python_bin}")" && pwd -P)"
readonly python_dir
python_bin="${python_dir}/$(basename "${python_bin}")"

if ! "${python_bin}" -c "import PyInstaller" 2>/dev/null; then
  echo "build-sidecar: Install PyInstaller in ${python_bin}." >&2
  echo "  Install the reviewed release toolchain with the following command." >&2
  printf '    %q -m pip install --require-hashes --only-binary=:all: -r %q\n' \
    "${python_bin}" "${sidecar_dir}/requirements/toolchain.txt" >&2
  exit 1
fi

bin_name="supraspina-sidecar"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    bin_name="supraspina-sidecar.exe"
    ;;
esac

readonly asset_dirs=(
  enigma
  features
  figstyle
  fonts
  pybrainage
  step7
  step8
  step9
)
for asset in "${asset_dirs[@]}"; do
  if [[ ! -d "${resources_dir}/${asset}" ]]; then
    echo "build-sidecar: Restore the required resources/${asset} directory." >&2
    exit 1
  fi
done
node "${app_dir}/scripts/stage-sidecar-resources.mjs" --output "${staging_dir}"
# Record the source commit, the tracked-change state, and the release-tag match
# of this build. Run manifests carry them; without the record the frozen sidecar
# reports an unknown source commit.
node "${app_dir}/scripts/build-identity.mjs" \
  --output "${staging_dir}/metadata/build-identity.json"
if [[ ! -f "${sidecar_dir}/pyinstaller_entry.py" ]]; then
  echo "build-sidecar: Restore sidecar/pyinstaller_entry.py before building." >&2
  exit 1
fi

cd "${sidecar_dir}"
SUPRASPINA_PYINSTALLER_STAGING="${staging_dir}" \
  "${python_bin}" -m PyInstaller \
  --noconfirm --clean \
  --distpath "${sidecar_dir}/dist" \
  --workpath "${sidecar_dir}/build" \
  "${sidecar_dir}/supraspina-sidecar.spec"

readonly bundle_dir="${sidecar_dir}/dist/supraspina-sidecar"
if [[ ! -s "${bundle_dir}/${bin_name}" ]]; then
  echo "build-sidecar: Restore the frozen sidecar launcher as a nonempty file." >&2
  exit 1
fi
if [[ ! -d "${bundle_dir}/supraspina-runtime" ]]; then
  echo "build-sidecar: Restore the frozen sidecar runtime directory." >&2
  exit 1
fi

mapfile -t bundle_entries < <(
  find "${bundle_dir}" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort
)
if [[ "${#bundle_entries[@]}" -ne 2 ||
  "${bundle_entries[0]:-}" != "supraspina-runtime" ||
  "${bundle_entries[1]:-}" != "${bin_name}" ]]; then
  echo "build-sidecar: Keep only ${bin_name} and supraspina-runtime in the frozen bundle." >&2
  exit 1
fi

mkdir "${out_dir}"
cp -R "${bundle_dir}/." "${out_dir}/"
if [[ ! -s "${out_dir}/${bin_name}" ]]; then
  echo "build-sidecar: Restore the frozen sidecar output as a nonempty file." >&2
  exit 1
fi
mapfile -t output_entries < <(
  find "${out_dir}" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort
)
if [[ "${#output_entries[@]}" -ne 2 ||
  "${output_entries[0]:-}" != "supraspina-runtime" ||
  "${output_entries[1]:-}" != "${bin_name}" ]]; then
  echo "build-sidecar: Write only ${bin_name} and supraspina-runtime to package staging." >&2
  exit 1
fi
echo "build-sidecar: Find the frozen sidecar at ${out_dir}/${bin_name}" \
  "alongside its supraspina-runtime directory." >&2
