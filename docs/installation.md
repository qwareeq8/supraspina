# Installation and platform support

Supraspina is packaged only as Linux x86_64 AppImage and deb packages, and
the application refuses to start on another operating system. It targets native
Ubuntu 22.04 and 24.04; on Windows, run it in Ubuntu under WSL2 with WSLg. There
are no Windows or macOS packages.

## Choose and verify a package

Download packages only from the
[GitHub Releases](https://github.com/qwareeq8/supraspina/releases) of
`qwareeq8/supraspina`. Each release tag is `v<version>`; version numbers are
explained in [Release identity](releasing.md#release-identity). The installable files
are `supraspina-<version>-amd64.deb` and `supraspina-<version>-x86_64.AppImage`.
The `latest-linux.yml` file is the update channel that packaged builds read and
is not needed for installation. Files under a local `release/` directory are
build output, not released packages. A release without these files carries
source only; run it from a checkout as [Set up and
run](development.md#set-up-and-run) describes.

Check the package against the co-hosted `SHA256SUMS` under its original release
filename, and rename it only after that check. The checksum detects changed
bytes but is not an independent signature.

```bash
# Debian package.
sha256sum --check --ignore-missing SHA256SUMS
mv supraspina-*-amd64.deb supraspina.deb
sudo apt install ./supraspina.deb

# Or the AppImage.
sha256sum --check --ignore-missing SHA256SUMS
mv supraspina-*-x86_64.AppImage supraspina.AppImage
chmod +x supraspina.AppImage
./supraspina.AppImage
```

`apt` installs the dependencies the deb declares. The AppImage expects a
standard Ubuntu Desktop installation; add these libraries if they are missing:

```bash
# Ubuntu 22.04.
sudo apt update
sudo apt install libasound2 libgbm1 libfuse2

# Ubuntu 24.04.
sudo apt update
sudo apt install libasound2t64 libgbm1 libfuse2t64
```

If FUSE mounting is unavailable, run `./supraspina.AppImage
--appimage-extract-and-run`. That runs the extracted payload but does not test
desktop mounting or double-click launch. The AppImage launcher keeps Chromium's
sandbox enabled when unprivileged user namespaces work and adds `--no-sandbox`
by itself only when `unshare -Ur` fails, so do not add that flag manually.

## Packaged runtime and external tools

The package includes Electron, the frozen Python sidecar, first-party support
files, public notices, dependency manifests, and a verified micromamba
executable, so no host Python is needed to run the application. It does not
include the scientific tools or any license file. Each enabled stage needs the
following, and Diagnostics reports what is missing:

| Enabled work                 | Operator-provided requirement                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| High-FOV Brain FOV cropping  | Apptainer 1.5.3 and the managed SynthStrip 1.8 CPU SIF. In-range inputs pass through unchanged.                                               |
| FreeSurfer reconstruction    | A FreeSurfer installation with `recon-all` and a FreeSurfer license. 8.x is recommended.                                                      |
| Optional defacing            | The selected `mri_deface` with its templates, `fsl_deface`, or `pydeface`. The `skip` mode copies the reviewed input unchanged.               |
| FastSurfer reconstruction    | Apptainer 1.5.3, a managed FastSurfer 2.5.4 CPU or CUDA SIF, and a FreeSurfer license.                                                        |
| ENIGMA QC                    | Licensed MATLAB for the source backend, or MATLAB Runtime R2019b (9.7) for the compiled backend, plus an X display or `xvfb-run`.             |
| Age, Clinical, and Brain-PAD | A separate analysis Python with the exact packages Diagnostics lists, including `cliffs-delta` 1.0.0.                                         |
| PyBrainAge                   | Host `curl`, an explicitly provisioned micromamba environment, and the checksum-pinned model and scaler.                                      |
| BrainCharts (off by default) | Linux x86_64, host `curl`, and the explicitly set-up runtime and checksum-pinned GPL-3.0 lifespan model, downloaded after the license notice. |
| R analysis                   | Rscript and the packages Diagnostics lists. Report rendering also needs Pandoc.                                                               |

Run Diagnostics after saving the project. A missing tool blocks only the enabled
stages that need it. Supraspina checks that the FreeSurfer license path exists
but never reads, displays, copies, hashes, or bundles the license. The license
file dialog in Diagnostics filters on `.txt` and `.license` files; a license
saved as `.license` is a hidden file, so press Ctrl+H to show it.

Diagnostics reports the detected FreeSurfer release but does not enforce a
version. Use 8.x, and keep one version throughout a cohort; the reconstruction
flags were set on 7.4.1 and kept for 8.x. The ENIGMA QC parameter `fsVersion`
defaults to `7`, so set it to `8` for FreeSurfer 8 reconstructions. It selects
the input volume and thalamus labels, and input preparation rejects a value
that does not match the provider major version recorded in every current
reconstruction receipt. The plan also blocks ENIGMA QC when `fsVersion` differs
from the detected FreeSurfer major version. FastSurfer 2.5.4 receipts select
FreeSurfer 7 compatibility.

ENIGMA QC has two backends. The default `auto` uses licensed MATLAB when it is
installed and MATLAB Runtime otherwise, so either one satisfies the step;
`matlab` or `mcr` pins one. The source backend runs the QC `.m` files with
MATLAB and the Image Processing Toolbox, using the executable chosen in
Diagnostics or found on `PATH`. The compiled backend needs no MATLAB license. It
runs the reviewed compiled programs against MATLAB Runtime R2019b (9.7), whose
root must provide `runtime/glnxa64/libmwmclmcrrt.so.9.7`; other Runtime
releases are rejected. A blank `mcrRoot` is looked up in
`/usr/local/MATLAB/MATLAB_Runtime`, `/usr/local/MATLAB`,
`/opt/MATLAB/MATLAB_Runtime`, and `/opt/mcr`, each with or without the `v97`
directory the installer appends, so the recommended silent install needs no
further configuration. Diagnostics links the MathWorks pages for both routes
and shows the Runtime silent-install command for you to copy and run with
`sudo`. A change of backend, executable, or Runtime root takes effect without a
restart.

The outlier review and the R analysis run `Rscript` from the project
configuration, or from `PATH` when none is set; the R analysis stage can name its
own interpreter, and Diagnostics checks the report packages against the
interpreter that stage runs. On Ubuntu, a missing R or Pandoc row shows the
`sudo apt-get install r-base` or `sudo apt-get install pandoc` command to copy,
with a link to the [R project](https://www.r-project.org) or the [Pandoc
installation instructions](https://pandoc.org/installing.html). Missing
`rmarkdown` and `knitr` packages can be installed from the app, which runs the
stage's own `Rscript` against `https://cloud.r-project.org` and writes only to
the per-user `R_LIBS_USER` library. Supraspina never runs a system install.

## Managed and acquired resources

Supraspina contacts the network only for the update check described under
[Updates and source development](#updates-and-source-development) and for
resource operations the operator authorizes:

- Online SIF pulls read the pinned OCI registry images through the
  operator-installed Apptainer.
- Scientific asset acquisition downloads the pinned SCI_Map archive, unless it
  can rebuild from files already on the machine.
- PyBrainAge provisioning fetches the exact conda-forge artifacts in the
  committed lock, a hash-pinned `cliffs-delta` wheel through pip, and the model
  archive from Zenodo.
- BrainCharts setup fetches the model archive and its site and phenotype lists
  from GitHub at a pinned commit, and its hash-pinned pip lock from PyPI and the
  PyTorch CPU index.

Every download is pinned by hash, so neither package solving nor an index can
substitute different bytes. Review
[`THIRD_PARTY_NOTICES`](../THIRD_PARTY_NOTICES) before acquisition or
redistribution.

### Container images

SynthStrip and FastSurfer SIFs are obtained only after an explicit operator
action. An online pull and an offline import both require the version,
platform, variant, byte count, and SHA-256 recorded in
[`SCIENTIFIC_RESOURCE_PINS.json`](../SCIENTIFIC_RESOURCE_PINS.json). A CUDA
variant also requires a working NVIDIA host stack and a successful
in-container PyTorch probe. Supraspina never substitutes another image or
device.

Online pulls run Apptainer 1.5.3 from `PATH`. The `docker://` references name
OCI registry images; Docker itself is not used. Install Apptainer from the
packages on the [Apptainer releases
page](https://github.com/apptainer/apptainer/releases). The Apptainer row in
Scientific resources reports the detected release, and Refresh scientific
resources checks again after an install. A pull with no Apptainer, or with
another release, fails before downloading anything. The offline import
verifies an existing SIF file and needs no Apptainer.

An online pull needs free space for twice the image size plus 512 MiB in the
Electron user-data filesystem, which with the current pins is about 1.21 GiB for
SynthStrip CPU, 3.93 GiB for FastSurfer CPU, and 10.78 GiB for FastSurfer CUDA.
An offline import needs the image size plus 512 MiB. Managed SIFs are stored in
the machine-local `scientific-resources/` directory under Electron's user data.

### Scientific assets

The ENIGMA QC and SCI_Map files have unresolved redistribution terms, so they
are downloaded into a machine-local cache outside packages, source checkouts,
and project data. An update that changes only the Structural data aggregation,
R analysis, or BrainCharts normative modeling scripts keeps the cache and runs
those scripts from the package. An update that changes a file in the ENIGMA QC
or feature extraction set, or re-pins an acquired file, invalidates the cache,
and Diagnostics then offers to rebuild it from the files already on the machine
without a download.

To acquire the assets on a machine without network access, download the pinned
archive,
`https://codeload.github.com/ortizo-117/SCI_Map/tar.gz/8a8c2d3586a37bb896bd8bdc3743b43e602827e3`,
elsewhere and pass it with `--archive`; the acquisition verifies its SHA-256
before using it. An installed deb runs
`/opt/Supraspina/resources/sidecar/supraspina-sidecar --acquire-scientific-assets --archive <tar.gz>`,
and a source checkout runs
`uv run --project sidecar --all-extras --locked python -m supraspina_sidecar.scientific_assets --acquire --archive <tar.gz>`.
Without `--archive`, both commands download the archive themselves.

### PyBrainAge and BrainCharts

PyBrainAge provisioning needs at least 5 GiB free. It records a 108,063,062-byte
model archive, limits the unpacked model to 2 GiB, and keeps the environment,
micromamba root, package caches, locks, model, and provisioning state under
`${paths.outputDir}/.pybrainage/`. There is no complete offline workflow for
PyBrainAge.

The PyBrainAge environment uses Python 3.7.12 to match the reviewed
scikit-learn 0.24.2 model. Python 3.7 is end of life and receives no security
fixes, so Supraspina uses this environment only for the PyBrainAge prediction
command, never as the Age, Clinical, or Brain-PAD interpreter. Do not reuse it
for other scripts or expose it as a network service.

BrainCharts setup needs at least 4 GiB free under
`${paths.outputDir}/.braincharts/`. It records a 2,796,655-byte model archive
that unpacks to about 127 MB and builds a runtime of about 2 GB with Python
3.12, pcntoolkit 0.35.0, and CPU-only PyTorch.

## WSL2

Install Ubuntu 22.04 or 24.04 under WSL2 and confirm that WSLg opens Linux
desktop applications. Install the deb inside that distribution and start
`supraspina` from its shell. Keep project and imaging data in the Linux
filesystem when you can; Windows drives under `/mnt/` are slower and handle
permissions differently. Run every scientific tool inside the same
distribution. WSL2 runs Supraspina but is not a release-build host.

## Updates and source development

Packaged builds check GitHub Releases for a newer version; when they check and
how each package installs an update is described in
[Adjust preferences](user-guide.md#adjust-preferences). Install a new deb as in
[Choose and verify a package](#choose-and-verify-a-package).

To run from source, follow [Development](development.md). Release builds use a
separate, pinned toolchain; do not build a release from a development
environment.
