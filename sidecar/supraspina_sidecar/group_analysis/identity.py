"""The engine and random-generator identity every stored result records.

Kept apart from ``engine`` so the RPC process (the manager judging result
currency) never imports numpy; only the compute worker loads the engine.
"""

from __future__ import annotations

ENGINE_ID = "ols-freedman-lane-maxt-v1"
#: The v2 engine (``engine_v2``). It reproduces ``ENGINE_ID`` byte for byte on
#: an upgraded v1 specification, so v1 results stay current.
ENGINE_ID_V2 = "ols-glh-freedman-lane-v2"
RNG_ID = "numpy-pcg64"
