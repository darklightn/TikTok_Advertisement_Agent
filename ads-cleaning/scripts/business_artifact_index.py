"""Deterministic business-artifact naming and unique authoritative selection."""
from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any


class BusinessArtifactError(ValueError):
    pass


def campaign_hourly_filename(metric_date: str, campaign_scope: str, campaign_ids: list[str], short_id: str, suffix: str) -> str:
    date.fromisoformat(metric_date)
    ids = sorted({str(value) for value in campaign_ids})
    if campaign_scope == "explicit" and len(ids) == 1:
        scope = f"计划_{ids[0]}"
    elif campaign_scope == "all" and ids:
        scope = "全部计划"
    else:
        raise BusinessArtifactError("campaign_scope_invalid")
    if not short_id or not suffix.startswith("."):
        raise BusinessArtifactError("artifact_identity_invalid")
    return f"{metric_date}__{scope}__{short_id}{suffix.lower()}"


def validate_entry(entry: dict[str, Any]) -> dict[str, Any]:
    for field in ("dataset_name", "shop_id", "advertiser_id", "coverage_start", "coverage_end", "path", "sha256", "authority_id"):
        if not isinstance(entry.get(field), str) or not entry[field]:
            raise BusinessArtifactError(f"index_{field}_invalid")
    start = date.fromisoformat(entry["coverage_start"]); end = date.fromisoformat(entry["coverage_end"])
    if start > end or not Path(entry["path"]).is_file():
        raise BusinessArtifactError("index_coverage_or_path_invalid")
    if entry.get("campaign_scope") not in {"explicit", "all", "not_applicable"}:
        raise BusinessArtifactError("index_campaign_scope_invalid")
    ids = entry.get("campaign_ids")
    if not isinstance(ids, list) or len(ids) != len(set(ids)):
        raise BusinessArtifactError("index_campaign_ids_invalid")
    if entry["campaign_scope"] == "explicit" and len(ids) != 1:
        raise BusinessArtifactError("index_explicit_campaign_invalid")
    if entry.get("completeness") not in {"complete", "partial"} or entry.get("authoritative") not in {True, False}:
        raise BusinessArtifactError("index_authority_invalid")
    if entry["completeness"] != "complete" and entry["authoritative"] is True:
        raise BusinessArtifactError("partial_cannot_be_authoritative")
    return entry


def select_authoritative(entries: list[dict[str, Any]], query: dict[str, Any]) -> dict[str, Any]:
    start = date.fromisoformat(query["coverage_start"]); end = date.fromisoformat(query["coverage_end"])
    campaign_id = str(query["campaign_id"])
    candidates = []
    for raw in entries:
        entry = validate_entry(raw)
        if any(str(entry.get(field)) != str(query.get(field)) for field in ("dataset_name", "shop_id", "advertiser_id")):
            continue
        if entry["authoritative"] is not True or entry["completeness"] != "complete" or campaign_id not in entry["campaign_ids"]:
            continue
        entry_start = date.fromisoformat(entry["coverage_start"]); entry_end = date.fromisoformat(entry["coverage_end"])
        if entry_start <= start and entry_end >= end:
            candidates.append((0 if entry_start == start and entry_end == end else 1, (entry_end - entry_start).days, entry))
    if not candidates:
        raise BusinessArtifactError("authoritative_artifact_not_found")
    candidates.sort(key=lambda item: (item[0], item[1], item[2]["authority_id"]))
    best = candidates[0]
    if len(candidates) > 1 and candidates[1][:2] == best[:2]:
        raise BusinessArtifactError("overlapping_authority_ambiguous")
    return best[2]
