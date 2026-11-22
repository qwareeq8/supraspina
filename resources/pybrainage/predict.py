#!/usr/bin/env python3
"""Predict brain age and Brain-PAD from a FreeSurfer feature table.

A first-party, argv-driven reimplementation of the upstream SCI_Map PyBrainAge
``predict.py`` step. Load the pinned ExtraTrees model and StandardScaler. Apply them
to an ``ID,Age,feature1..187`` table, and write
``ID,Age,BrainAge,BrainPAD``. Run under the provisioned micromamba environment
with Python 3.7, scikit-learn 0.24.2, pandas 1.3.4, and NumPy 1.20.3.

Accept FreeSurfer's ``_and_`` and ``Left-Thalamus`` feature names. Retry scaler
application with the PyBrainAge ``&`` and ``-Proper`` spellings only when the
initial transform rejects the input. Calculate ``BrainPAD`` as
``BrainAge - Age`` so positive values indicate an older-appearing brain.

Chronological age is not a model input, so a subject whose ``Age`` cell is
blank still receives a brain-age prediction. Only ``BrainPAD`` is undefined
for that subject: it is left empty in the output table, and one bounded
warning on standard error names the subjects it covers.
"""

from __future__ import annotations

import argparse
import csv
import os
import pickle
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

MAX_FEATURE_BYTES = 64 * 1024 * 1024
MAX_FEATURE_ROWS = 5_000
MAX_FEATURE_COLUMNS = 1_024
MAX_FIELD_BYTES = 1024 * 1024
MAX_PICKLE_BYTES = 1024 * 1024 * 1024
EXPECTED_FEATURE_COLUMNS = 187
#: Bound the subject list in the unknown-age warning.
MAX_LISTED_IDS = 20
csv.field_size_limit(MAX_FIELD_BYTES)


def expected_feature_header(template_path: str) -> list[str]:
    """Return the exact ID, Age, and trained FreeSurfer feature order."""
    template = Path(template_path)
    with template.open(newline="", encoding="utf-8") as handle:
        header = next(csv.reader(handle, delimiter="\t"), [])
    if len(header) != EXPECTED_FEATURE_COLUMNS + 2 or header[:2] != ["ID", "Age"]:
        raise ValueError("Restore the reviewed PyBrainAge feature-order template.")
    return [
        "ID",
        "Age",
        *[
            name.replace("&", "_and_")
            .replace("Left-Thalamus-Proper", "Left-Thalamus")
            .replace("Right-Thalamus-Proper", "Right-Thalamus")
            for name in header[2:]
        ],
    ]


def rename_cols_to_roi_format(data: pd.DataFrame) -> pd.DataFrame:
    """Rename FreeSurfer columns to the scaler's ``&`` / ``-Proper`` convention."""
    renamed = {}
    for col in data.columns:
        new = col.replace("_and_", "&")
        new = new.replace("Left-Thalamus", "Left-Thalamus-Proper")
        new = new.replace("Right-Thalamus", "Right-Thalamus-Proper")
        renamed[col] = new
    return data.rename(columns=renamed)


def validate_features(data: pd.DataFrame) -> None:
    """Raise the documented ``ValueError`` on missing/infinite/non-numeric data.

    Preserve the load-bearing substrings ``missing data``, ``infinite value``,
    and ``non-numeric data`` for the adapter's failure parser.
    """
    if data.isnull().to_numpy().any():
        raise ValueError("Remove missing data from the dataframe.")
    if data.isin([np.inf, -np.inf]).to_numpy().sum() != 0:
        raise ValueError("Remove every infinite value from the dataframe.")
    try:
        data.astype(float)
    except (ValueError, TypeError) as exc:
        raise ValueError("Convert non-numeric data in the dataframe.") from exc


def apply_scaler(scaler: Any, data: pd.DataFrame) -> np.ndarray:
    """Scale features and retry with the scaler's ROI-name convention on failure.

    Raise ``ValueError`` when the scaler cannot be applied after the renamed
    retry.
    """
    try:
        return scaler.transform(data)
    except ValueError:
        sys.stderr.write(
            "Retry with the ROI-name convention after the scaler rejects the "
            "FreeSurfer column names.\n"
        )
        renamed = rename_cols_to_roi_format(data)
        try:
            return scaler.transform(renamed)
        except ValueError as exc:
            raise ValueError(
                "Check whether the scaler is loaded correctly and the data use "
                "the required format after scaler application fails."
            ) from exc


def predict_ages(model: Any, data: np.ndarray, row_fallback: bool) -> np.ndarray:
    """Return one predicted brain age per subject.

    With ``row_fallback``, retry one subject at a time after a whole-cohort
    failure.
    """
    if not row_fallback:
        return np.ravel(model.predict(data))
    try:
        return np.ravel(model.predict(data))
    except Exception:
        sys.stderr.write("Retry the failed whole-cohort model call row by row.\n")
        outputs = []
        # Use the slow per-row guard only as the upstream-faithful last resort.
        for row in range(len(data)):
            try:
                outputs.append(model.predict(data[row].reshape(1, -1))[0])
            except Exception as exc:  # noqa: PERF203
                raise ValueError(f"Inspect row {row}; prediction failed.") from exc
        return np.asarray(outputs)


def _bounded_ids(subject_ids: list[str]) -> str:
    """Return a bounded, comma-separated subject list for one warning line."""
    listed = ", ".join(subject_ids[:MAX_LISTED_IDS])
    if len(subject_ids) > MAX_LISTED_IDS:
        listed += ", ..."
    return listed


def chronological_ages(ages: pd.Series) -> np.ndarray:
    """Return chronological ages in years, keeping an unknown age as ``nan``.

    A blank ``Age`` cell marks an unknown age. Raise ``ValueError`` when a
    supplied age is not a finite number of years.
    """
    values = pd.to_numeric(ages, errors="coerce")
    supplied = ages.astype("string").str.strip().fillna("") != ""
    invalid = supplied & (values.isna() | ~np.isfinite(values))
    if bool(np.asarray(invalid).any()):
        raise ValueError("Provide finite chronological Age values in years.")
    return np.asarray(values, dtype=float)


def _read_features(path: str) -> pd.DataFrame:
    """Read a bounded regular feature CSV for one analysis cohort."""
    info = os.stat(path, follow_symlinks=True)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FEATURE_BYTES:
        raise ValueError("Keep the PyBrainAge feature CSV within 64 MiB.")
    with open(path, newline="", encoding="utf-8-sig") as handle:
        header = next(csv.reader(handle), [])
    if len(header) > MAX_FEATURE_COLUMNS:
        raise ValueError("Keep the PyBrainAge feature CSV within 1024 columns.")
    frame = pd.read_csv(path, nrows=MAX_FEATURE_ROWS + 1)
    if len(frame.columns) > MAX_FEATURE_COLUMNS:
        raise ValueError("Keep the PyBrainAge feature CSV within 1024 columns.")
    if len(frame) > MAX_FEATURE_ROWS:
        raise ValueError("Keep the PyBrainAge cohort within 5000 rows.")
    return frame


def _load_pickle(path: str) -> Any:
    """Load a pickled artifact from ``path``."""
    info = os.stat(path, follow_symlinks=True)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PICKLE_BYTES:
        raise ValueError("Keep each verified PyBrainAge artifact within 1 GiB.")
    with open(path, "rb") as handle:
        return pickle.load(handle)  # noqa: S301 - provisioned, sha-checked artifact


def run(args: argparse.Namespace) -> None:
    """Load the model + scaler, predict, and write the prediction table."""
    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)

    frame = _read_features(args.features)
    expected = expected_feature_header(args.template)
    actual = list(frame.columns)
    if actual != expected:
        mismatch = next(
            (
                index
                for index, (received, wanted) in enumerate(zip(actual, expected))
                if received != wanted
            ),
            min(len(actual), len(expected)),
        )
        received = actual[mismatch] if mismatch < len(actual) else "missing"
        wanted = expected[mismatch] if mismatch < len(expected) else "no extra column"
        raise ValueError(
            "Restore the exact trained PyBrainAge feature order; column "
            f"{mismatch + 1} is {received!r}, expected {wanted!r}."
        )
    ids = frame.iloc[:, 0]
    ages = frame.iloc[:, 1]
    data = frame.iloc[:, 2:]

    normalized_ids = [str(value).strip() for value in ids]
    if any(not value for value in normalized_ids) or len(normalized_ids) != len(
        set(normalized_ids)
    ):
        raise ValueError("Provide non-empty, unique IDs for PyBrainAge.")
    validate_features(data)
    age_values = chronological_ages(ages)

    model = _load_pickle(args.model)
    scaler = _load_pickle(args.scaler)

    scaled = apply_scaler(scaler, data)
    brain_ages = predict_ages(model, scaled, args.row_fallback)
    brain_age_values = np.asarray(brain_ages, dtype=float)
    if len(brain_age_values) != len(frame) or not np.isfinite(brain_age_values).all():
        raise ValueError("Require one finite BrainAge prediction per subject.")

    result = pd.DataFrame(
        {
            "ID": np.asarray(normalized_ids),
            "Age": age_values,
            "BrainAge": brain_age_values,
        }
    )
    result["BrainPAD"] = result["BrainAge"] - result["Age"]
    known_age = np.isfinite(age_values)
    pad_values = result["BrainPAD"].to_numpy(dtype=float)
    if not np.isfinite(pad_values[known_age]).all():
        raise ValueError("Require finite Brain-PAD values.")
    unknown_age = [
        subject for subject, known in zip(normalized_ids, known_age) if not known
    ]
    descriptor, temporary = tempfile.mkstemp(prefix=".predicted-results-", dir=out_dir)
    os.close(descriptor)
    try:
        result.to_csv(temporary, index=False)
        with open(temporary, "rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, args.output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    if unknown_age:
        sys.stderr.write(
            f"WARNING: No chronological age for {len(unknown_age)} subject(s): "
            f"{_bounded_ids(unknown_age)}; Brain-PAD is left empty for them.\n"
        )
    sys.stderr.write(f"Review {args.output} with {len(result)} subjects.\n")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Parse the command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--features", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--scaler", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--row-fallback", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Predict brain age and return a process exit code."""
    run(parse_args(argv))
    return 0


if __name__ == "__main__":
    sys.exit(main())
