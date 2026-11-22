# Local Linux release procedure

Release artifacts are built and accepted outside GitHub Actions on a
maintainer-controlled native Ubuntu 22.04 x86_64 host. WSL2 and
cross-compilation are not qualified release-build paths. Hosted CI validates
source on version tags; it does not build, install, publish, or accept packages.

## Release identity

A Supraspina version names the UTC minute it was stamped. The machine form is
`YYYYMMDD.HHMM.0`, with HHMM written as an integer without leading zeros, so
09:05 UTC on 2026-11-21 is `20261121.905.0` and 18:30 UTC is
`20261121.1830.0`. The machine form stays a valid semantic version, so npm,
electron-builder, and electron-updater order releases by time. The application
and its documentation show the display form, `2026-11-21 18:30 UTC`.
`scripts/app-version.mjs` holds the one parser and formatter that the
application and the release scripts share.

`npm run version:stamp` sets the version from the current UTC minute in every
file that must agree: `package.json`, both root versions in
`package-lock.json`, `version` and `date-released` in `CITATION.cff`,
`releaseInfo.releaseDate` in `electron-builder.yml`, `sidecar/pyproject.toml`,
`sidecar/uv.lock`, and `sidecar/supraspina_sidecar/__init__.py`. Each release
date is the UTC date that the version names. `npm run check:release` reads the
same field list from `scripts/stamp-version.mjs` and rejects a missing field, a
disagreement, or another version form. Between releases the committed version is
the last stamp, not a published package.

A release tag is `v<machine form>`, annotated with the message
`Supraspina <machine form>`, for example `v20261121.1830.0` with message
`Supraspina 20261121.1830.0`. Commits and tags are unsigned. Every release sits
on ordinary `main` history: its version must be later than the latest release
tag, that annotated tag must be in its ancestry, and authenticated `main` and
the new tag must resolve to the intended commit. Tags in any other form take no
part in that ordering.

Build and accept the exact tagged bytes locally before pushing `main` or the tag
to the public repository.
GitHub immutable tags and releases are deliberately disabled, so the platform
does not stop a published tag or release from changing; the procedure does.
Publish any correction as a newly stamped version on a normal descendant of
`main`, never reuse a published version or filename, and require separate
explicit owner authorization before changing an already published tag or
release. `scripts/check-github-release-settings.mjs` verifies
this mutable policy: disabled immutable releases, no ruleset that prohibits
updating or deleting a release tag, and no-bypass deletion and force-push
protection on `main`.

Generated package metadata binds every locally accepted package to the canonical
repository, version, derived `v<version>` tag, full commit and tree object IDs,
a clean source tree, and reviewed configuration and lock hashes. The tag value
is available before package construction, and the local annotated tag must
resolve to the same commit. The metadata also records the deliberate unsigned
Linux package decision in machine-readable form. Package staging is exact and
refuses prior ignored output.

Every package, including a lab build of `main`, also records its build identity
at package time: the full source commit, whether tracked files differed from
it, and whether that commit is the annotated `v<version>` tag.
`scripts/build-identity.mjs` embeds the record in the renderer and in the
frozen sidecar. Only a clean tree at the exact tag reads "Version <display
form>" in About and records the `release` build in run manifests; any other
package names itself a development build of its short commit.

Before `npm run package:linux` builds anything, `scripts/build-sidecar.sh`
checks `build/release-metadata/dependency-manifests`, which electron-builder
copies into every package and which outlives the release build that generated
it. When the directory exists, its release package manifest must describe the
exact clean source being packaged; otherwise packaging stops and names the
version and commit that the manifest describes. A lab build of `main` stages no
release metadata, so remove a directory left by an earlier release build before
packaging. Its package then carries no generated dependency metadata or release
package manifest, and the package smoke checks, which require both, apply only
to release packages.

## Prepare the release identity

On `main`, stamp the version and recapture the documentation screenshots. The
stamp changes `package.json`, which the screenshot manifest records as source:

```bash
set -euo pipefail
npm run version:stamp
npm run check:release
npm run build
npm run screenshots:documentation
npm run check:screenshots
```

`npm run check:release` confirms that every stamped file carries the version
and its release date. Review the new captures as
[Recapture the set](development.md#recapture-the-set) describes, then commit
the stamped files and captures as the release commit and tag it:

```bash
set -euo pipefail
git commit --all --message \
  "chore(release): stamp $(node -p "require('./package.json').version")"
version="$(node -p "require('./package.json').version")"
git tag --annotate "v${version}" --message "Supraspina ${version}"
```

Use the clean release head on `main`. Derive the version and asset paths from
the package metadata:

```bash
set -euo pipefail
version="$(node -p "require('./package.json').version")"
tag="v${version}"
deb="release/supraspina-${version}-amd64.deb"
appimage="release/supraspina-${version}-x86_64.AppImage"
```

Run the remaining blocks in this same Bash session. Each block re-enables
strict mode and checks the variables it consumes before any guarded action.

Confirm the release topology before source verification or packaging. Identify
the previous release tag, if one exists, and require the candidate version to
follow it:

```bash
test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain=v1)"
test "$(git log -1 --format='%an <%ae>' HEAD)" = \
  "Yusuf Qwareeq <120707909+qwareeq8@users.noreply.github.com>"
test "$(git log -1 --format='%cn <%ce>' HEAD)" = \
  "Yusuf Qwareeq <120707909+qwareeq8@users.noreply.github.com>"
previous_tag="$(git tag --list 'v[1-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].*.0' \
  --sort=-version:refname \
  | grep --invert-match --line-regexp --fixed-strings "${tag}" \
  | head -n 1 || true)"
if test -n "${previous_tag}"; then
  test "$(git cat-file -t "refs/tags/${previous_tag}")" = "tag"
  git merge-base --is-ancestor "${previous_tag}^{commit}" HEAD
  test "${version}" != "${previous_tag#v}"
  highest_version="$(printf '%s\n%s\n' "${previous_tag#v}" "${version}" \
    | sort -V | tail -n 1)"
  test "${highest_version}" = "${version}"
fi
test "$(git cat-file -t "refs/tags/${tag}")" = "tag"
test "$(git rev-parse "${tag}^{commit}")" = "$(git rev-parse HEAD)"
test "$(git for-each-ref --format='%(contents:subject)' "refs/tags/${tag}")" = \
  "Supraspina ${version}"
test "$(git remote get-url origin)" = \
  "https://github.com/qwareeq8/supraspina.git"
git diff --check
git fsck --full --strict
```

`sort -V` orders the machine form numerically, so `20261121.905.0` sorts
before `20261121.1830.0`; `node scripts/check-release.mjs --mode strict`
enforces the same order.

Run the complete [source verification](development.md#source-verification)
before building.

## Transfer the exact source

The candidate commit and its tag stay unpublished until qualification finishes,
so a bundle carries them to the build and acceptance hosts without pushing
either one or placing a credential on any host. From the final local
repository, create one checksum-bound Git bundle that contains `main` and every
`v*` tag. The previous release tag, when one exists, travels with the
candidate, because the strict gate and the host checks resolve it. Create the
new tag locally before this step. Keep this transfer outside the repository:

```bash
set -euo pipefail
: "${version:?Run Prepare the release identity first.}"
: "${tag:?Run Prepare the release identity first.}"
source_transfer="../supraspina-${version}-source-transfer"
source_bundle="${source_transfer}/supraspina-${version}.bundle"
test ! -e "${source_transfer}"
mkdir "${source_transfer}"
git bundle create "${source_bundle}" \
  refs/heads/main '--glob=refs/tags/v*'
git bundle verify "${source_bundle}"
(
  cd "${source_transfer}"
  sha256sum "$(basename "${source_bundle}")" > SHA256SUMS
)
```

Transfer that directory without changing its bytes. On the native Ubuntu 22.04
build host, and later on each acceptance host, create a new checkout from the
same bundle. Set `SUPRASPINA_SOURCE_TRANSFER` to the transferred directory and
`SUPRASPINA_CHECKOUT_PARENT` to an existing directory that does not contain a
candidate checkout:

```bash
set -euo pipefail
: "${SUPRASPINA_SOURCE_TRANSFER:?Set the transferred source directory.}"
: "${SUPRASPINA_CHECKOUT_PARENT:?Set a new checkout parent.}"
: "${SUPRASPINA_RELEASE_VERSION:?Set the release version being qualified.}"
version="${SUPRASPINA_RELEASE_VERSION}"
tag="v${version}"
source_transfer="$(realpath "${SUPRASPINA_SOURCE_TRANSFER}")"
source_bundle="${source_transfer}/supraspina-${version}.bundle"
checkout="$(realpath "${SUPRASPINA_CHECKOUT_PARENT}")/supraspina-${version}"
(
  cd "${source_transfer}"
  sha256sum --check SHA256SUMS
)
# Git before 2.38 refuses `bundle verify` outside a repository, so verify the
# transferred bundle from a throwaway empty repository on every host.
verify_repo="$(mktemp -d)"
git -C "${verify_repo}" init --quiet
git -C "${verify_repo}" bundle verify "${source_bundle}"
rm -rf "${verify_repo}"
test ! -e "${checkout}"
git clone --branch main "${source_bundle}" "${checkout}"
cd "${checkout}"
git remote set-url origin https://github.com/qwareeq8/supraspina.git
git remote set-url --add --push origin DISABLED
test "$(git remote get-url origin)" = \
  "https://github.com/qwareeq8/supraspina.git"
test "$(git remote get-url --push origin)" = "DISABLED"
test "$(git branch --show-current)" = "main"
test "$(git cat-file -t "refs/tags/${tag}")" = "tag"
test "$(git rev-parse "${tag}^{}")" = "$(git rev-parse HEAD)"
previous_tag="$(git tag --list 'v[1-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].*.0' \
  --sort=-version:refname \
  | grep --invert-match --line-regexp --fixed-strings "${tag}" \
  | head -n 1 || true)"
if test -n "${previous_tag}"; then
  git merge-base --is-ancestor "${previous_tag}^{commit}" HEAD
fi
test "$(node -p "require('./package.json').version")" = "${version}"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git fsck --full --strict
```

Do not fetch from or push to `origin` in these checkouts, which hold exactly
the transferred source. The disabled push URL makes an accidental push fail
before network publication.

## Build on Ubuntu 22.04

Use Node.js 22.13 or later in the 22.x line and exact Python 3.12.10.
Install `bash`, `curl`, `file`, `sha256sum`, `dpkg-deb`, `apt`, `sudo`, and
`xvfb-run` for the build and local acceptance commands. Cold-install the hashed
release requirements, stage the pinned micromamba 2.7.0-0 Linux x86_64
executable, and generate dependency manifests before packaging.

The micromamba executable ships through `extraResources` from
`resources/micromamba/micromamba`, a path Git ignores. A release package
requires that file to be present and executable. Supraspina never downloads or
replaces micromamba at run time; it uses the bundled, verified executable only
for operator-authorized PyBrainAge provisioning.

Resolve `python3.12` to a real CPython 3.12.10 interpreter rather than a
launcher shim such as the uv or pyenv trampoline, because a virtual environment
created through a shim records the shim directory as its home and then fails
with `ModuleNotFoundError: No module named 'encodings'`. When
`readlink -f "$(command -v python3.12)"` names a shim, put the resolved
interpreter first on `PATH` for this build:

```bash
set -euo pipefail
npm ci
test "$(python3.12 -c 'import platform; print(platform.python_version())')" = 3.12.10
release_python_dir="build/release-python-3.12.10"
release_python="${release_python_dir}/bin/python"
test ! -e "${release_python_dir}"
python3.12 -m venv "${release_python_dir}"
"${release_python}" -m pip install --require-hashes --only-binary=:all: \
  -r sidecar/requirements/toolchain.txt
"${release_python}" -m pip install --require-hashes --only-binary=:all: \
  -r sidecar/requirements/release-linux-x86_64.txt
"${release_python}" -m pip install --no-deps --no-build-isolation \
  -e ./sidecar
"${release_python}" -m pip check

mkdir -p resources/micromamba
curl -fL \
  https://github.com/mamba-org/micromamba-releases/releases/download/2.7.0-0/micromamba-linux-64 \
  -o resources/micromamba/micromamba
printf '%s  %s\n' \
  fb4554d61a1c567726890169e39c41aa8495dbba56f50957ee7356572b6c5726 \
  resources/micromamba/micromamba | sha256sum -c -
chmod 0755 resources/micromamba/micromamba
release_mamba_root="build/release-mamba-root"
test ! -e "${release_mamba_root}"
test "$(MAMBA_ROOT_PREFIX="${release_mamba_root}" \
  resources/micromamba/micromamba --version)" = "2.7.0"

test ! -e build/release-metadata/dependency-manifests
test ! -e sidecar/build
test ! -e sidecar/dist
test ! -e resources/sidecar
test ! -e release
npm run metadata:node
"${release_python}" sidecar/scripts/generate_release_metadata.py \
  --target linux-x86_64 \
  --output build/release-metadata/dependency-manifests
SUPRASPINA_BUILD_PYTHON="${release_python}" \
  npm run package:linux
```

`npm run metadata:node` builds the renderer before it writes the Node
manifests, because the notices and SBOM also cover the packages Vite bundles
into the renderer, such as React and NiiVue; the build records them in
`out/renderer/bundled-packages.json`, and the script refuses to run without
that record. `npm run package:linux` freezes the sidecar and builds both
AppImage and deb.
The package script hardcodes `--publish never`; packaging cannot implicitly
create or update a GitHub release.
Preserve the complete local build output until acceptance is finished.

## Accept the exact package bytes

On the build host, create one transfer bundle containing the package manifest
and the three exact files that both native hosts must inspect:

```bash
set -euo pipefail
: "${version:?Run Prepare the release identity first.}"
: "${deb:?Run Prepare the release identity first.}"
: "${appimage:?Run Prepare the release identity first.}"
acceptance_bundle="build/native-release-acceptance-${version}"
acceptance_assets="${acceptance_bundle}/assets"
acceptance_manifest="${acceptance_bundle}/release-package-manifest.json"
test ! -e "${acceptance_bundle}"
mkdir -p "${acceptance_assets}"
cp "${deb}" "${acceptance_assets}/"
cp "${appimage}" "${acceptance_assets}/"
cp release/latest-linux.yml "${acceptance_assets}/"
cp build/release-metadata/dependency-manifests/release-package-manifest.json \
  "${acceptance_manifest}"

build_record="${acceptance_bundle}/ubuntu-22.04-native-build.json"
node scripts/release-acceptance.mjs record-build \
  --assets "${acceptance_assets}" \
  --package-manifest "${acceptance_manifest}" \
  --command-result node-install=0 \
  --command-result verify-python-version=0 \
  --command-result create-release-python=0 \
  --command-result install-python-toolchain=0 \
  --command-result install-python-release=0 \
  --command-result install-sidecar-source=0 \
  --command-result check-python-release=0 \
  --command-result download-micromamba=0 \
  --command-result verify-micromamba-sha256=0 \
  --command-result make-micromamba-executable=0 \
  --command-result verify-micromamba-version=0 \
  --command-result generate-node-metadata=0 \
  --command-result generate-python-metadata=0 \
  --command-result package-linux=0 \
  --output "${build_record}"
```

Run `record-build` immediately after the successful packaging block. It
requires the exact package-bound source and artifact bytes, refuses any host
other than native Ubuntu 22.04 x86_64, and captures the observed kernel,
distribution, architecture, Node, npm, Python, pip, Bash, curl, `sha256sum`,
`file`, `dpkg-deb`, glibc, Electron, electron-builder, electron-vite,
PyInstaller, and micromamba versions. Its isolated micromamba probe uses the
same `build/release-mamba-root` as the recorded build command. Each
`--command-result` is the actual exit code, or `not-run`; the all-zero example
is valid only because the preceding strict-mode build block completed. Preserve
a failed build record for diagnosis, but the merge gate accepts only all-zero
build outcomes.

Transfer that bundle and the same checksum-verified source transfer without
changing their bytes to clean native Ubuntu 22.04 and 24.04 x86_64 hosts.
Create each checkout with
[Transfer the exact source](#transfer-the-exact-source), then place the
acceptance bundle at `build/native-release-acceptance-<version>` inside it.
Install a supported Node.js release before continuing. Run transfer verification
before `npm ci`, system prerequisite installation, either smoke script, or
either application package. The block acquires the scientific assets once per
host from the packaged binary before the smokes, which fail with the
`runtime-contract` failure code without them.
[Scientific assets](installation.md#scientific-assets) says which changes
invalidate an acquired generation. The same acquisition command rebuilds an
invalidated generation from the files on disk and downloads the archive only
when a file no longer matches:

```bash
set -euo pipefail
version="$(node -p "require('./package.json').version")"
acceptance_bundle="build/native-release-acceptance-${version}"
acceptance_assets="${acceptance_bundle}/assets"
acceptance_manifest="${acceptance_bundle}/release-package-manifest.json"
build_record="${acceptance_bundle}/ubuntu-22.04-native-build.json"
test -s "${acceptance_manifest}"
test -s "${build_record}"
node scripts/release-acceptance.mjs verify-transfer \
  --assets "${acceptance_assets}" \
  --package-manifest "${acceptance_manifest}" \
  --build-record "${build_record}"

npm ci
source /etc/os-release
test "${ID}" = "ubuntu"
case "${VERSION_ID}" in
  22.04) fuse_package="libfuse2" ;;
  24.04) fuse_package="libfuse2t64" ;;
  *) exit 1 ;;
esac
sudo apt-get update
sudo apt-get install --yes file xvfb "${fuse_package}"

deb_name="supraspina-${version}-amd64.deb"
appimage_name="supraspina-${version}-x86_64.AppImage"

# Every packaged smoke reads scientific assets whose redistribution terms keep
# them out of the package, and smoke-installed-deb.sh additionally runs with
# --native-science. Acquire the assets once per host from the packaged binary
# into the user's data directory, where every smoke lane reads them, then
# remove the package again so the deb smoke starts from an uninstalled host.
sudo apt-get install --yes "./${acceptance_assets}/${deb_name}"
"/opt/Supraspina/resources/sidecar/supraspina-sidecar" --acquire-scientific-assets
sudo apt-get purge --yes supraspina
! dpkg-query --show --showformat='${Status}\n' supraspina 2>/dev/null \
  | grep -qx 'install ok installed'

scripts/smoke-installed-deb.sh "${acceptance_assets}/${deb_name}"
scripts/smoke-appimage.sh "${acceptance_assets}/${appimage_name}"
node scripts/inspect-linux-packages.mjs \
  --appimage "${acceptance_assets}/${appimage_name}" \
  --deb "${acceptance_assets}/${deb_name}"

sudo apt-get install --yes "./${acceptance_assets}/${deb_name}"
normal_deb_status=0
/usr/bin/supraspina || normal_deb_status=$?
sudo apt-get purge --yes supraspina
! dpkg-query --show --showformat='${Status}\n' supraspina 2>/dev/null \
  | grep -qx 'install ok installed'
test "${normal_deb_status}" -eq 0
"${acceptance_assets}/${appimage_name}"

host_record="${acceptance_bundle}/ubuntu-${VERSION_ID}-release-acceptance.json"
node scripts/release-acceptance.mjs record \
  --assets "${acceptance_assets}" \
  --package-manifest "${acceptance_manifest}" \
  --build-record "${build_record}" \
  --deb-smoke passed \
  --appimage-smoke passed \
  --package-inspection passed \
  --deb-normal-launch passed \
  --appimage-normal-launch passed \
  --pybrainage-provisioning passed \
  --pybrainage-readiness passed \
  --synthetic-output-reopen passed \
  --output "${host_record}"
```

For each normal-launch command, the operator must observe the Supraspina window,
exercise the intended launch path, and close the application before the command
returns and the block continues. Do not background the command or replace it
with a launcher that returns before observation; a pasted block does not by
itself establish a passed normal-launch outcome.

The deb smoke installs the deb as the sole package argument, checks its resolved
dependencies and installed ELF closure, runs the fixed package contract,
provisions and revalidates PyBrainAge, performs real synthetic prediction,
reopens the Clinical and prediction outputs, purges `supraspina`, and proves that
its owned files were removed. Its successful fixed report is the evidence for
the three PyBrainAge and output-reopening result flags. The later deb install is
the required reinstall. These operations belong on a disposable clean machine
or VM. The direct AppImage command exercises its normal FUSE launch path; the
extraction fallback alone does not qualify.

The `verify-transfer` and `record` commands detect the Ubuntu release,
architecture, kernel, and WSL state and refuse Mint, WSL, or any unsupported
host. `record` also requires a supported Node.js version and records exact
Node, npm, Bash, dpkg, apt, file, Xvfb, and FUSE package versions. Its JSON
Schema is `scripts/release-acceptance.schema.json`. Supply `passed`, `failed`,
or `not-run` for every actual result. The block above is valid only after all
eight checks pass. Preserve a failed record for diagnosis; the merge gate will
not accept it.

Package checks cover the exact source-identity manifest and unsigned decision,
embedded sidecar, public notices, dependency locks, provenance,
scientific-resource pins, micromamba digest, launcher metadata, icons, and
Chromium sandbox policy. They do not accept external scientific tools, GPU
drivers, study configuration, scanner hardware, or institutional deployment.

## Merge acceptance and assemble release assets

Return both canonical host records to the build host. Copy the two application
packages and generated `release/latest-linux.yml` into a new, otherwise empty
`release-assets/` directory, then merge and verify the build record and two host
records. The YAML file is the update channel that packaged builds read, not an
application package for users.

```bash
set -euo pipefail
: "${version:?Run Prepare the release identity first.}"
: "${deb:?Run Prepare the release identity first.}"
: "${appimage:?Run Prepare the release identity first.}"
: "${acceptance_bundle:?Complete native acceptance first.}"
: "${acceptance_manifest:?Complete native acceptance first.}"
build_record="${acceptance_bundle}/ubuntu-22.04-native-build.json"
host_record_2204="${acceptance_bundle}/ubuntu-22.04-release-acceptance.json"
host_record_2404="${acceptance_bundle}/ubuntu-24.04-release-acceptance.json"
test -s "${build_record}"
test -s "${host_record_2204}"
test -s "${host_record_2404}"
test ! -e release-assets
mkdir release-assets
cp "${deb}" release-assets/
cp "${appimage}" release-assets/
cp release/latest-linux.yml release-assets/
node scripts/release-acceptance.mjs merge \
  --assets release-assets \
  --package-manifest "${acceptance_manifest}" \
  --build-record "${build_record}" \
  --host-record "${host_record_2204}" \
  --host-record "${host_record_2404}" \
  --output release-assets/release-acceptance.json
node scripts/release-acceptance.mjs verify \
  --assets release-assets \
  --package-manifest "${acceptance_manifest}" \
  --build-record "${build_record}" \
  --host-record "${host_record_2204}" \
  --host-record "${host_record_2404}" \
  --acceptance release-assets/release-acceptance.json
node scripts/release-assets.mjs create release-assets "${version}"
node scripts/release-assets.mjs verify release-assets "${version}"
```

The merged `release-acceptance.json` embeds the canonical native Ubuntu 22.04
build record and both native acceptance-host records. It binds their release
tag, source identity, package manifest, exact core artifact bytes, observed
hosts and tools, build and acceptance command vectors and outcomes, and
unsigned decision. `SHA256SUMS` includes this record in the user-facing
integrity inventory. Keep the artifacts local until the release commit, tag,
and hosted authority are valid.

## Required GitHub repository settings

Configure these repository-specific settings before pushing a release tag. The
checker itself is read-only.

- Keep `qwareeq8/supraspina` public, because packaged builds read its releases
  without credentials, and set `main` as the default branch.
- Keep GitHub immutable releases disabled, and do not enable organization-level
  release immutability for this repository.
- Keep an active branch ruleset with no bypass actors or exclusions that
  includes exactly `refs/heads/main`, restricts deletion, and blocks force
  pushes. Do not add an `update` rule; that freezes `main` and blocks ordinary
  fast-forward release commits.
- Do not create any ruleset that restricts deletion, updates, or force pushes on
  `refs/tags/v*`. Published tags stay technically mutable under the current
  policy. Restricting tag creation is still permitted.
- Leave ref creation and ordinary fast-forward updates permitted so new release
  tags and later release commits can be created.

Run `node scripts/check-github-release-settings.mjs` to verify this policy.

## Push, verify authority, and publish

Push only after source verification, the native Ubuntu 22.04 build, both native
acceptance lanes, release-asset verification, and release notes are complete.
Fast-forward push `main` with `git push origin HEAD:main`, which must not
trigger CI. The following publication checks then verify the settings above and
push the annotated tag once:

```bash
set -euo pipefail
: "${version:?Run Prepare the release identity first.}"
: "${tag:?Run Prepare the release identity first.}"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test "$(gh repo view qwareeq8/supraspina \
  --json nameWithOwner,isPrivate,defaultBranchRef \
  --jq '[.nameWithOwner, .isPrivate, .defaultBranchRef.name] | @tsv')" = \
  $'qwareeq8/supraspina\tfalse\tmain'
node scripts/check-github-release-settings.mjs
case "$(git remote get-url origin)" in
  https://github.com/qwareeq8/supraspina | \
    https://github.com/qwareeq8/supraspina.git | \
    git@github.com:qwareeq8/supraspina.git | \
    ssh://git@github.com/qwareeq8/supraspina.git) ;;
  *) echo "Refuse an unexpected origin." >&2; exit 1 ;;
esac
remote_tag_refs="$(git ls-remote --tags origin \
  "refs/tags/${tag}" "refs/tags/${tag}^{}")"
test -z "${remote_tag_refs}"
release_http_status="$(curl --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}' \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $(gh auth token)" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/qwareeq8/supraspina/releases/tags/${tag}")"
test "${release_http_status}" = "404"

git fetch --no-tags origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git push origin "refs/tags/${tag}"
```

Never force-push, and never move or delete a published release tag. If
qualification uncovers a source defect before publication, delete only the
unpushed local tag, correct `main` with ordinary commits, recreate the tag on
the new head, and repeat every affected source, build, and acceptance gate.
Never rewrite published history.

Wait for the tag-triggered hosted run and require it to pass:

```bash
set -euo pipefail
: "${tag:?Run Prepare the release identity first.}"
release_sha="$(git rev-parse HEAD)"
run_id=""
for ((poll = 0; poll < 60; poll += 1)); do
  run_id="$(
    gh run list \
      --workflow quality-gates.yml \
      --commit "${release_sha}" \
      --event push \
      --limit 100 \
      --json databaseId,headBranch,headSha \
      | jq -r --arg tag "${tag}" --arg sha "${release_sha}" \
        '[.[] | select(.headBranch == $tag and .headSha == $sha)] | .[0].databaseId // empty'
  )"
  test -n "${run_id}" && break
  sleep 2
done
test -n "${run_id}"
gh run watch "${run_id}" --exit-status

GH_TOKEN="$(gh auth token)" \
GITHUB_REPOSITORY=qwareeq8/supraspina \
GITHUB_REF_TYPE=tag \
GITHUB_REF_NAME="${tag}" \
GITHUB_REF="refs/tags/${tag}" \
GITHUB_SHA="${release_sha}" \
  npm run check:release:strict -- --artifacts release-assets
```

Write release notes for that byte set in an untracked file. Create a draft,
download the remote assets into a new temporary directory, and verify them
before publishing the draft:

```bash
set -euo pipefail
: "${version:?Run Prepare the release identity first.}"
: "${tag:?Run Prepare the release identity first.}"
: "${deb:?Run Prepare the release identity first.}"
: "${appimage:?Run Prepare the release identity first.}"
release_notes="${PWD}/release-notes-${version}.md"
test -s "${release_notes}"
test "$(gh api repos/qwareeq8/supraspina/immutable-releases \
  --jq .enabled)" = "false"

gh release create "${tag}" \
  "release-assets/$(basename "${deb}")" \
  "release-assets/$(basename "${appimage}")" \
  release-assets/latest-linux.yml \
  release-assets/release-acceptance.json \
  release-assets/SHA256SUMS \
  --repo qwareeq8/supraspina \
  --title "Supraspina ${version}" \
  --notes-file "${release_notes}" \
  --verify-tag \
  --draft

verification_dir="$(mktemp -d)"
gh release download "${tag}" \
  --repo qwareeq8/supraspina \
  --dir "${verification_dir}"
node scripts/release-assets.mjs verify "${verification_dir}" "${version}"

gh release edit "${tag}" \
  --repo qwareeq8/supraspina \
  --draft=false

published_dir="$(mktemp -d)"
gh release download "${tag}" \
  --repo qwareeq8/supraspina \
  --dir "${published_dir}"
node scripts/release-assets.mjs verify "${published_dir}" "${version}"
```

Because immutable releases are disabled, the published bytes are verified by
downloading them and re-checking `SHA256SUMS` rather than by a platform
attestation. After final remote verification, remove temporary download,
transfer, raw-record, and build directories. Do not replace a
published asset in place; changed bytes require a new release decision and a
newly stamped version.

## Source-only releases

A source-only release archives an exact source revision, for example to give
Zenodo a version to mint a DOI for, without packages. It skips the native
build, both acceptance lanes, and the release assets, and keeps every source
gate: stamp and commit the version, push `main` and the annotated tag with the
publication checks above, and require the tag-triggered hosted run to pass.
Then publish a release with no attached assets:

```bash
gh release create "${tag}" \
  --repo qwareeq8/supraspina \
  --title "Supraspina ${version}" \
  --notes-file "${release_notes}" \
  --verify-tag
```

While a source-only release is the latest release, a packaged build's update
check finds no `latest-linux.yml` and fails instead of offering it, so the next
packaged release ends that state.

## Rehearse the workflow

To rehearse the tag workflow before a real release, push the same commit and
tag to a disposable repository and set its Actions variable
`SUPRASPINA_RELEASE_REPOSITORY` to that repository's `owner/name`. The workflow
and `npm run check:release:strict` then authenticate refs against it instead of
`qwareeq8/supraspina`; nothing else changes. Delete the repository afterward.

## Update integrity

Publishing a release offers it as an update to every packaged build that
checks. electron-updater reads `latest-linux.yml` from the latest published
release, which excludes drafts and prereleases, and compares its version with
the running one. An AppImage downloads the new AppImage only after the operator
confirms, and electron-updater rejects a file whose SHA-512 differs from the
one in `latest-linux.yml`. A deb never installs an update; it links the
release page.

The packages are unsigned, so this check detects corrupted or substituted bytes
in transit, not a malicious release. The trust roots are the
`qwareeq8/supraspina` GitHub account and HTTPS to github.com and GitHub's
release-asset hosts (release-assets.githubusercontent.com and the older
objects.githubusercontent.com), the only hosts the updater session may reach:
anyone who can publish a release there can publish an update. Upload
`latest-linux.yml` only with the accepted packages it describes, and never
publish a prerelease.
