#!/usr/bin/env bash
#
# Install and verify one exact amd64 Debian artifact on a supported Ubuntu host.

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Run: smoke-installed-deb.sh <supraspina.deb>." >&2
  exit 2
fi

deb="$(realpath "$1")"
readonly deb
readonly package_name="supraspina"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project_dir
# shellcheck source=/dev/null
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
  echo "Run this smoke test only on Ubuntu 22.04 or 24.04; detected ${ID:-unknown} ${VERSION_ID:-unknown}." >&2
  exit 1
fi
test "$(dpkg-deb --field "${deb}" Architecture)" = "amd64"
test "$(dpkg-deb --field "${deb}" Package)" = "${package_name}"

if dpkg-query --show --showformat='${Status}\n' "${package_name}" \
  2>/dev/null | grep -qx 'install ok installed'; then
  echo "smoke-installed-deb: Start without an installed ${package_name} package." >&2
  exit 1
fi

package_installed=false
owned_inventory_captured=false
owned_non_directories=()
application_root=''

capture_owned_inventory() {
  local package_paths
  if ! package_paths="$(dpkg-query --listfiles "${package_name}")"; then
    return 1
  fi
  owned_non_directories=()
  while IFS= read -r path; do
    if [[ -n "${path}" && ( -f "${path}" || -L "${path}" ) ]]; then
      owned_non_directories+=("${path}")
    fi
  done <<<"${package_paths}"
  if [[ "${#owned_non_directories[@]}" -eq 0 ]]; then
    return 1
  fi
  owned_inventory_captured=true
}

cleanup_installation() {
  local status=$?
  local cleanup_failed=false
  trap - EXIT
  if [[ "${package_installed}" == true ]]; then
    if [[ "${owned_inventory_captured}" != true ]] && ! capture_owned_inventory; then
      echo "smoke-installed-deb: Could not capture the installed file inventory." >&2
      cleanup_failed=true
    fi
    if ! sudo apt-get purge --yes "${package_name}"; then
      echo "smoke-installed-deb: Could not purge ${package_name}." >&2
      cleanup_failed=true
    fi
    if dpkg-query --show --showformat='${Status}\n' "${package_name}" \
      2>/dev/null | grep -qx 'install ok installed'; then
      echo "smoke-installed-deb: ${package_name} remains installed after purge." >&2
      cleanup_failed=true
    fi
    for path in "${owned_non_directories[@]}"; do
      if [[ -e "${path}" || -L "${path}" ]]; then
        echo "smoke-installed-deb: Purge left the package-owned path: ${path}." >&2
        cleanup_failed=true
      fi
    done
    if [[ -n "${application_root}" &&
      (-e "${application_root}" || -L "${application_root}") ]]; then
      echo "smoke-installed-deb: Purge left the application root: ${application_root}." >&2
      cleanup_failed=true
    fi
  fi
  if [[ "${status}" -ne 0 || "${cleanup_failed}" == true ]]; then
    exit 1
  fi
}
trap cleanup_installation EXIT

sudo apt-get update
sudo apt-get install --yes xvfb
if sudo apt-get install --yes "${deb}"; then
  package_installed=true
else
  if dpkg-query --show "${package_name}" >/dev/null 2>&1; then
    package_installed=true
  fi
  echo "smoke-installed-deb: The Debian package installation failed." >&2
  exit 1
fi
capture_owned_inventory
sudo apt-get check
test "$(dpkg-query --show --showformat='${Architecture}' "${package_name}")" = "amd64"
test -x /usr/bin/supraspina
executable="$(readlink -f /usr/bin/supraspina)"
readonly executable
application_root="$(dirname "${executable}")"
readonly application_root
readonly resources_path="${application_root}/resources"
file "${executable}" | grep -Eq 'ELF 64-bit.*x86-64'

elf_count=0
while IFS= read -r -d '' path; do
  description="$(file --brief -- "${path}")"
  if [[ "${description}" != ELF* ]]; then
    continue
  fi
  if [[ ! "${description}" =~ ELF\ 64-bit.*x86-64 ]]; then
    echo "smoke-installed-deb: Require an x86-64 ELF: ${path}: ${description}." >&2
    exit 1
  fi
  ((elf_count += 1))
  ldd_status=0
  ldd_output="$(ldd "${path}" 2>&1)" || ldd_status=$?
  if grep -Eq '(^|[[:space:]])not found([[:space:]]|$)' <<<"${ldd_output}"; then
    echo "smoke-installed-deb: Resolve every ELF dependency for ${path}." >&2
    printf '%s\n' "${ldd_output}" >&2
    exit 1
  fi
  if [[ "${ldd_status}" -ne 0 ]] &&
    ! grep -Eq 'statically linked|not a dynamic executable' <<<"${ldd_output}"; then
    echo "smoke-installed-deb: Inspect ELF dependencies for ${path}." >&2
    printf '%s\n' "${ldd_output}" >&2
    exit 1
  fi
done < <(find "${application_root}" -type f -print0)
if [[ "${elf_count}" -eq 0 ]]; then
  echo "smoke-installed-deb: Find the installed application ELF closure." >&2
  exit 1
fi

node "${project_dir}/scripts/verify-packaged-application.mjs" \
  --application-root "${application_root}" \
  --resources "${resources_path}" \
  --target linux-x86_64

# Inspect this artifact's control record, launcher metadata, and icons.
node "${project_dir}/scripts/inspect-linux-packages.mjs" --deb "${deb}"

timeout --signal=TERM --kill-after=10s 3700s \
  xvfb-run -a npm --prefix "${project_dir}" run smoke:package -- \
  --executable /usr/bin/supraspina --type deb --native-science
