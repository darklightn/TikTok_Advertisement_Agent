"""Deterministic JSON and file hashing helpers."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from typing import Any
from .errors import CleaningError


def _json_bytes(value: Any) -> bytes:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    return text.encode("utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleaningError("manifest_unreadable", f"cannot read Manifest: {path}") from exc
    if not isinstance(value, dict):
        raise CleaningError("manifest_invalid", "Manifest must be an object")
    return value
