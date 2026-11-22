#!/usr/bin/env bash
# Compiles the two BrainCharts runtime locks that braincharts_runtime.py pins.
#
# The pip lock resolves sidecar/requirements/braincharts/pyproject.toml for
# CPython 3.12 on Linux x86_64 with uv, bounded by the upload-date cutoff
# below so a rerun gives the same pins. The PyTorch CPU index publishes no
# upload dates, so torch is exempt from the cutoff; its version is fixed by
# the rest of the resolution. The lock names no index: pip's command line
# supplies PyPI and the CPU index, because an index line in a requirements
# file would replace both. bspline has no wheel and installs from its
# hashed sdist. The conda lock holds only CPython and pip (with the
# setuptools that builds bspline, which must equal the pip lock's pin) and is
# solved by the reviewed micromamba; conda has no date cutoff, so its lock is
# the record. After a rerun, update the SHA-256 pins in braincharts_runtime.py.
#
# Usage: scripts/compile-braincharts-locks.sh <micromamba 2.7.0 executable>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
locks="$root/sidecar/supraspina_sidecar/braincharts_locks"
micromamba="${1:?Name the reviewed micromamba 2.7.0 executable.}"
cutoff="2026-09-30T00:00:00Z"
python_spec="python=3.12.14"
pip_spec="pip=26.2.1"
setuptools_spec="setuptools=84.0.0"

uv pip compile "$root/sidecar/requirements/braincharts/pyproject.toml" \
  --python-version 3.12 \
  --python-platform x86_64-manylinux_2_28 \
  --generate-hashes \
  --only-binary :all: \
  --no-binary bspline \
  --exclude-newer "$cutoff" \
  --exclude-newer-package torch=false \
  --custom-compile-command "scripts/compile-braincharts-locks.sh" \
  --quiet \
  -o "$locks/braincharts-requirements.txt"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
MAMBA_ROOT_PREFIX="$scratch/root" CONDA_PKGS_DIRS="$scratch/root/pkgs" \
  "$micromamba" create --yes --dry-run --json \
  --prefix "$scratch/env" \
  --override-channels --channel conda-forge --platform linux-64 \
  "$python_spec" "$pip_spec" "$setuptools_spec" >"$scratch/solve.json"
python3 - "$scratch/solve.json" "$locks/braincharts-linux-64.lock" <<'PY'
import json
import sys

solve = json.load(open(sys.argv[1], encoding="utf-8"))
lines = ["@EXPLICIT"]
lines += [f"{item['url']}#{item['sha256']}" for item in solve["actions"]["LINK"]]
with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as handle:
    handle.write("\n".join(lines) + "\n")
PY
sha256sum "$locks/braincharts-requirements.txt" "$locks/braincharts-linux-64.lock"
