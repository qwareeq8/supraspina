"""Private configuration and data access shared by every analysis script.

The configuration is a YAML file that names where the private inputs live and where outputs go.
It is read from the path in the ANALYSES_CONFIG environment variable, or from analyses/config.yaml
(git-ignored). config.example.yaml documents every key. Participant-level tables are written only
under `work_dir`; `output_dir` receives group-level tables and figures.
"""

from __future__ import annotations

import os
import re
from functools import cache
from pathlib import Path

import pandas as pd
import yaml

ANALYSES = Path(__file__).resolve().parents[1]

# Columns that could identify a person are dropped on every read, so a script never sees them.
IDENTIFIER_COLUMNS = re.compile(r"mrn|record|dob|birth|date|name|accession", re.IGNORECASE)

# Columns of the participants table (one row per analyzed participant; see README.md).
PARTICIPANT_COLUMNS = ("participant_id", "sci", "age", "female", "eTIV")


@cache
def load() -> dict:
    path = Path(os.environ.get("ANALYSES_CONFIG", ANALYSES / "config.yaml"))
    if not path.exists():
        raise SystemExit(f"No configuration at {path}. Copy config.example.yaml and fill in the private paths.")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def get(key: str, default=None):
    """Value of a dotted key such as "atlases.jhu_labels"."""
    node = load()
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            if default is not None:
                return default
            raise SystemExit(f"Configuration key {key!r} is not set (see config.example.yaml).")
        node = node[part]
    return node


def path(key: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(get(key)))))


def work_dir(section: str) -> Path:
    """Participant-level folder of one analysis section (private; never published)."""
    p = path("work_dir") / section
    p.mkdir(parents=True, exist_ok=True)
    return p


def output_dir(section: str) -> Path:
    """Group-level output folder of one analysis section."""
    p = path("output_dir") / section
    p.mkdir(parents=True, exist_ok=True)
    return p


def read_private(p: Path | str, **kw) -> pd.DataFrame:
    """Read a private table without its identifier-like columns."""
    d = pd.read_csv(p, **kw)
    return d.drop(columns=[c for c in d.columns if IDENTIFIER_COLUMNS.search(str(c))])


def participants() -> pd.DataFrame:
    """The analyzed sample, sorted by participant_id, with eTIV also in liters (eTIV_l)."""
    d = read_private(path("participants"))
    # Optional renames let an existing private table be used as is ({column in this code: column in the file}).
    ren = {v: k for k, v in (load().get("participant_columns") or {}).items()}
    d = d.rename(columns=ren)
    missing = [c for c in PARTICIPANT_COLUMNS if c not in d.columns]
    if missing:
        raise SystemExit(f"The participants table lacks columns {missing}.")
    assert d.participant_id.is_unique, "participant_id must be unique."
    d = d.sort_values("participant_id").reset_index(drop=True)
    d["eTIV_l"] = d.eTIV / 1e6
    return d


def ids(p: Path | str) -> list[str]:
    """Participant IDs from a private list file (one per line; '#' starts a comment)."""
    p = Path(p)
    if not p.exists():
        return []
    return [ln.split()[0] for ln in p.read_text().splitlines() if ln.strip() and not ln.startswith("#")]
