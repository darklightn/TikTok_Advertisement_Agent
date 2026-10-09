#!/usr/bin/env python3
"""Generate the versioned deterministic record key defined by the model contract."""

from __future__ import annotations

import hashlib
import json
import unicodedata

DOMAIN = "tiktok-cleaning-record-key-v1"


def _normalize(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError("record-key components must be strings or null")
    return unicodedata.normalize("NFC", value)


def canonical_payload(dataset_name: str, component_values: list[str | None]) -> str:
    payload = [DOMAIN, _normalize(dataset_name), [_normalize(value) for value in component_values]]
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def record_key(dataset_name: str, component_values: list[str | None]) -> str:
    return hashlib.sha256(canonical_payload(dataset_name, component_values).encode("utf-8")).hexdigest()
