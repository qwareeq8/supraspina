"""Interactive group analysis of the pipeline's region tables.

The package serves the ``groupAnalysis.*`` methods: a measure catalog from
the aggregation and Brain-PAD tables, the resolved sample of a draft
specification, and computes that run in a separate worker process
(``worker.py``) so the RPC thread never blocks. Results and saved
specifications live under ``.supraspina/analysis/``; nothing here plans, runs a
pipeline stage, writes receipts, or touches ``outputs/``.

Modules: ``spec`` (spec v1 and v2, canonical digests, measure IDs),
``catalog``, ``dataset`` (sample resolution and bounded reads),
``distributions`` (pure Python t, F, and noncentral-t), ``engine`` (OLS,
corrections, Freedman-Lane max-T; numpy, loaded only by the worker),
``engine_v2`` (general linear hypotheses, t and F terms, spec v2 designs;
numpy, worker only), ``engine_input`` (the v2 engine's input),
``result_detail`` (a v2 result's measure detail),
``identity`` (the engine and RNG IDs), ``store``, ``worker``, ``manager``
(the RPC surface), and ``export``; for v2, ``fsstats`` (per-subject stats
files), ``sources`` (tier A sources and imported variables),
``design_check``, and the on-demand atlas labeling: ``atlas_recipes``,
``atlas_sources`` (the external sources and their machine-level cache),
``atlas_manager`` (the labeling RPC surface), and ``atlas_worker``.
"""
