"""Sanitized CycloneDX and notices generated for a release-lock environment."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import stat
import uuid
from pathlib import Path
from typing import Any

import tomllib

_EXPECTED_PYTHON = "3.12.10"
_TARGET_LOCKS = {
    "linux-x86_64": "release-linux-x86_64.txt",
}
_LICENSE_NAME = re.compile(
    r"^(?:licen[cs]e|copying|notice)(?:[._-].*)?$", re.IGNORECASE
)
_MAX_LICENSE_BYTES = 2 * 1024 * 1024
_NODE_METADATA_NAMES = frozenset(
    {
        "node-distributable.cyclonedx.json",
        "node-distributable.json",
        "node-third-party-notices.txt",
        "release-package-manifest.json",
    }
)


def _prepare_output(output: Path) -> set[str]:
    if output.is_symlink():
        raise ValueError(
            "Provide the release-metadata destination as a real directory."
        )
    if output.exists():
        if not output.is_dir():
            raise ValueError(
                "Provide the release-metadata destination as a real directory."
            )
    else:
        output.mkdir(mode=0o700, parents=True)
    entries = {entry.name for entry in output.iterdir()}
    if entries not in (set(), set(_NODE_METADATA_NAMES)):
        raise ValueError(
            "Start Python release metadata with an empty destination or the exact "
            f"Node predecessor files; found: {', '.join(sorted(entries)) or 'none'}."
        )
    for name in entries:
        path = output / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(
                f"Provide the Node predecessor as a nonempty regular file: {name}."
            )
    return entries


def _write_exclusive(path: Path, value: str) -> None:
    with path.open("x", encoding="utf-8") as handle:
        handle.write(value)
    path.chmod(0o644)


def _normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _logical_requirements(value: str) -> list[str]:
    result: list[str] = []
    current = ""
    for raw in value.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        continued = line.endswith("\\")
        current += (" " if current else "") + line.removesuffix("\\").strip()
        if not continued:
            result.append(current)
            current = ""
    if current:
        raise ValueError("Terminate the final release-lock continuation.")
    return result


def parse_lock(path: Path) -> dict[str, dict[str, Any]]:
    """Parse only exact, SHA-256-hashed requirements."""
    result: dict[str, dict[str, Any]] = {}
    pattern = re.compile(
        r"^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)"
        r"(?:\s*;\s*[^\\]+)?\s+(.*)$"
    )
    for line in _logical_requirements(path.read_text(encoding="utf-8")):
        match = pattern.fullmatch(line)
        if match is None:
            raise ValueError(f"Use an exact requirement in {path.name}.")
        raw_name, version, suffix = match.groups()
        hashes = re.findall(r"--hash=sha256:([a-f0-9]{64})", suffix)
        if not hashes:
            raise ValueError(f"Add a SHA-256 hash to every requirement in {path.name}.")
        if re.sub(r"--hash=sha256:[a-f0-9]{64}", "", suffix).strip():
            raise ValueError(f"Remove unsupported requirement syntax from {path.name}.")
        name = _normalize(raw_name)
        if name in result:
            raise ValueError(f"Remove the duplicate requirement from {path.name}.")
        result[name] = {
            "name": raw_name,
            "version": version,
            "lockHashes": sorted(hashes),
        }
    return result


def _metadata_value(metadata: Any, *names: str) -> str | None:
    for name in names:
        value = metadata.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _license_files(
    distribution: importlib.metadata.Distribution,
) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for entry in distribution.files or ():
        if not _LICENSE_NAME.match(Path(str(entry)).name):
            continue
        path = Path(distribution.locate_file(entry))
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_LICENSE_BYTES:
            raise ValueError(
                "Provide each dependency license as a bounded regular file."
            )
        value = path.read_bytes()
        result.append(
            {
                "name": Path(str(entry)).name,
                "sha256": hashlib.sha256(value).hexdigest(),
                "text": value.decode("utf-8", errors="replace"),
            }
        )
    return sorted(result, key=lambda item: (item["name"], item["sha256"]))


def installed_records(lock: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve exact installed metadata for every release-lock package."""
    installed = {
        _normalize(dist.metadata["Name"]): dist
        for dist in importlib.metadata.distributions()
        if dist.metadata.get("Name")
    }
    records = []
    for normalized, pinned in sorted(lock.items()):
        distribution = installed.get(normalized)
        if distribution is None or distribution.version != pinned["version"]:
            raise ValueError(
                f"Install the locked {pinned['name']}=={pinned['version']} dependency."
            )
        metadata = distribution.metadata
        records.append(
            {
                **pinned,
                "normalizedName": normalized,
                "declaredLicense": _metadata_value(
                    metadata, "License-Expression", "License"
                )
                or "NOASSERTION",
                "author": _metadata_value(metadata, "Author", "Author-email"),
                "projectUrl": _metadata_value(
                    metadata, "Home-page", "Project-URL", "Download-URL"
                ),
                "licenseFiles": _license_files(distribution),
            }
        )
    return records


def _cyclonedx(
    target: str,
    lock_path: Path,
    records: list[dict[str, Any]],
    application_version: str,
) -> dict[str, Any]:
    lock_sha = hashlib.sha256(lock_path.read_bytes()).hexdigest()
    serial = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"https://github.com/qwareeq8/supraspina/{target}/{lock_sha}",
    )
    components = []
    for record in records:
        licenses = (
            []
            if record["declaredLicense"] == "NOASSERTION"
            else [{"expression": record["declaredLicense"]}]
        )
        components.append(
            {
                "type": "library",
                "name": record["name"],
                "version": record["version"],
                "purl": f"pkg:pypi/{record['normalizedName']}@{record['version']}",
                "licenses": licenses,
                "properties": [
                    {
                        "name": "supraspina:release-lock",
                        "value": f"sidecar/requirements/{lock_path.name}",
                    },
                    {
                        "name": "supraspina:lock-sha256-count",
                        "value": str(len(record["lockHashes"])),
                    },
                ],
            }
        )
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{serial}",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "name": "Supraspina frozen Python sidecar",
                "version": application_version,
            },
            "properties": [
                {"name": "supraspina:target", "value": target},
                {"name": "supraspina:python", "value": _EXPECTED_PYTHON},
                {"name": "supraspina:lock-sha256", "value": lock_sha},
            ],
        },
        "components": components,
    }


def _notices(target: str, records: list[dict[str, Any]]) -> str:
    lines = [
        f"Supraspina frozen Python runtime notices ({target})",
        "=" * (45 + len(target)),
        "",
        (
            "Review these notices against the exact platform release lock and "
            "installed metadata."
        ),
        "",
    ]
    for record in records:
        heading = f"{record['name']} {record['version']}"
        lines.extend(
            [
                heading,
                "-" * len(heading),
                f"Declared license: {record['declaredLicense']}",
            ]
        )
        if record["author"]:
            lines.append(f"Author: {record['author']}")
        if record["projectUrl"]:
            lines.append(f"Project: {record['projectUrl']}")
        if not record["licenseFiles"]:
            lines.extend(
                [
                    "Retain the package metadata and attribution above because the",
                    "installed distribution provides no separate license file.",
                ]
            )
        for license_file in record["licenseFiles"]:
            lines.extend(
                [
                    "",
                    f"{license_file['name']} (SHA-256 {license_file['sha256']})",
                    license_file["text"].rstrip(),
                ]
            )
        lines.extend(["", ""])
    return "\n".join(lines).rstrip() + "\n"


def generate(target: str, output: Path, requirements: Path) -> tuple[Path, Path]:
    """Generate one platform's deterministic SBOM and notices."""
    if target not in _TARGET_LOCKS:
        raise ValueError(f"Select a supported release-metadata target: {target}.")
    predecessor_names = _prepare_output(output)
    lock_path = requirements / _TARGET_LOCKS[target]
    lock = parse_lock(lock_path)
    records = installed_records(lock)
    with (requirements.parent / "pyproject.toml").open("rb") as handle:
        application_version = tomllib.load(handle)["project"]["version"]
    # Releases use the UTC date-time version YYYYMMDD.HHMM.0 that
    # scripts/stamp-version.mjs writes.
    if not isinstance(application_version, str) or not re.fullmatch(
        r"[1-9]\d{7}\.(?:0|[1-9]\d{0,3})\.0", application_version
    ):
        raise ValueError(
            "Stamp the sidecar project version with npm run version:stamp."
        )
    sbom_path = output / f"python-release-{target}.cyclonedx.json"
    notice_path = output / f"python-release-{target}-notices.txt"
    _write_exclusive(
        sbom_path,
        json.dumps(
            _cyclonedx(target, lock_path, records, application_version),
            indent=2,
        )
        + "\n",
    )
    _write_exclusive(notice_path, _notices(target, records))
    expected_names = predecessor_names | {sbom_path.name, notice_path.name}
    actual_names = {entry.name for entry in output.iterdir()}
    if actual_names != expected_names:
        raise ValueError("Write exactly the reviewed release-metadata files.")
    return sbom_path, notice_path


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, choices=sorted(_TARGET_LOCKS))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--requirements",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "requirements",
    )
    parser.add_argument("--allow-python-patch-mismatch", action="store_true")
    return parser


def main() -> int:
    """Generate the selected platform metadata from the live locked environment."""
    args = _parser().parse_args()
    if (
        not args.allow_python_patch_mismatch
        and platform.python_version() != _EXPECTED_PYTHON
    ):
        raise SystemExit(
            f"Use Python {_EXPECTED_PYTHON} to generate release metadata instead "
            f"of Python {platform.python_version()}."
        )
    sbom, notices = generate(args.target, args.output, args.requirements)
    print(f"Generated the Python release metadata: {sbom.name}, {notices.name}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
