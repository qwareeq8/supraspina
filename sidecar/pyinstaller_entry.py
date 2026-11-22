"""Concrete PyInstaller entry point for the frozen Supraspina sidecar.

PyInstaller analyzes a concrete script instead of a ``-m module``
invocation, so this thin shim hands off to the package's ``main``, the same
entry used by the ``supraspina-sidecar`` console script and
``python -m supraspina_sidecar``. The build recipe lives in
``scripts/build-sidecar.sh`` at the repository root.
"""

# Run the frozen execution gate before the deliberately delayed package import.
# ruff: noqa: E402, I001, S606

from __future__ import annotations

import os
import sys


_EXEC_GATE_ARG = "--supraspina-exec-gate"
_ACQUIRE_ASSETS_ARG = "--acquire-scientific-assets"
# Mirror supraspina_sidecar.group_analysis.worker.WORKER_FLAG.
_GROUP_ANALYSIS_WORKER_ARG = "--supraspina-group-analysis-worker"
# Mirror supraspina_sidecar.group_analysis.atlas_worker.WORKER_FLAG.
_ATLAS_LABELING_WORKER_ARG = "--supraspina-atlas-labeling-worker"


def _run_exec_gate() -> None:
    """Block a frozen child before importing any sidecar package code."""
    token = sys.stdin.buffer.read(1)
    argv = sys.argv[2:]
    if token == b"1" and argv:
        os.execvpe(argv[0], argv, os.environ)
    os._exit(125)


if __name__ == "__main__" and sys.argv[1:2] == [_EXEC_GATE_ARG]:
    _run_exec_gate()

if __name__ == "__main__" and sys.argv[1:2] == [_ACQUIRE_ASSETS_ARG]:
    from supraspina_sidecar.scientific_assets import main as acquire_assets

    raise SystemExit(acquire_assets(["--acquire", *sys.argv[2:]]))

if __name__ == "__main__" and sys.argv[1:2] == [_GROUP_ANALYSIS_WORKER_ARG]:
    from supraspina_sidecar.group_analysis.worker import main as group_analysis_worker

    raise SystemExit(group_analysis_worker(sys.argv[2:]))

if __name__ == "__main__" and sys.argv[1:2] == [_ATLAS_LABELING_WORKER_ARG]:
    from supraspina_sidecar.group_analysis.atlas_worker import (
        main as atlas_labeling_worker,
    )

    raise SystemExit(atlas_labeling_worker(sys.argv[2:]))


from supraspina_sidecar.__main__ import main

if __name__ == "__main__":
    main()
