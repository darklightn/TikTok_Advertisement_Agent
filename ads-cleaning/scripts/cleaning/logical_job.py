"""Deterministic discovery and validation of current logical export-job inputs."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .conversion import _utc_datetime_value
from .errors import CleaningError
from .files import _read_json, _sha256
from .manifest_v3 import validate_v3_manifest

SCHEMA = "logical_export_job_manifest_v1"
CONTRACT_VERSION = "1.0.0"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


def _version_path(directory: Path, version: int) -> Path:
    return directory / f"v{version:08d}.json"


def _load_logical_job(export_root: Path, job_id: str, report_ids: list[str]) -> dict[str, Any]:
    directory = export_root / "_system" / "logical-export-jobs" / job_id
    paths = sorted(directory.glob("v*.json"))
    if not paths:
        raise CleaningError("logical_export_job_not_found", "logical export job does not exist")
    manifests: list[tuple[Path, dict[str, Any]]] = []
    for version, path in enumerate(paths, start=1):
        if path != _version_path(directory, version):
            raise CleaningError("logical_manifest_version_chain_invalid", "logical manifest versions are not contiguous")
        value = _read_json(path)
        if (
            value.get("schema_version") != SCHEMA
            or value.get("contract_version") != CONTRACT_VERSION
            or value.get("logical_export_job_id") != job_id
            or value.get("manifest_version") != version
            or value.get("supersedes_manifest_version") != (version - 1 or None)
        ):
            raise CleaningError("logical_manifest_version_chain_invalid", f"logical manifest version is invalid: {path}")
        manifests.append((path, value))
    first_request = manifests[0][1].get("normalized_request")
    first_compatibility = manifests[0][1].get("compatibility_identity")
    previous_children: list[str] = []
    for path, value in manifests:
        if value.get("normalized_request") != first_request or value.get("compatibility_identity") != first_compatibility:
            raise CleaningError("logical_manifest_identity_changed", f"logical job identity changed: {path}")
        children = value.get("child_export_batch_ids")
        if not isinstance(children, list) or children[:len(previous_children)] != previous_children:
            raise CleaningError("logical_manifest_append_only_violation", f"logical child batch chain changed: {path}")
        previous_children = children
    latest_path, latest = manifests[-1]
    _utc_datetime_value(latest.get("created_at_utc"), "logical_manifest.created_at_utc")
    _utc_datetime_value(latest.get("updated_at_utc"), "logical_manifest.updated_at_utc")
    requested = (latest.get("normalized_request") or {}).get("report_ids")
    if not isinstance(requested, list) or any(report_id not in requested for report_id in report_ids):
        raise CleaningError("report_not_in_logical_request", "selected report is absent from the logical request")
    if (latest.get("compatibility_identity") or {}).get("manifest_schema_version") != "export_batch_manifest_v3":
        raise CleaningError("unknown_export_contract_version", "logical job does not use export_batch_manifest_v3")
    authoritative = latest.get("authoritative_work_units")
    child_ids = latest.get("child_export_batch_ids")
    if not isinstance(authoritative, dict) or not isinstance(child_ids, list) or len(child_ids) != len(set(child_ids)):
        raise CleaningError("logical_manifest_invalid", "logical authority or child batch IDs are invalid")

    children: list[tuple[Path, dict[str, Any]]] = []
    selected: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    child_hashes: dict[str, str] = {}
    source_manifests: list[dict[str, Any]] = []
    source_artifacts: list[dict[str, Any]] = []
    authoritative_units: list[dict[str, Any]] = []
    attempts_by_identity: dict[tuple[str, str], dict[str, Any]] = {}
    for child_id in child_ids:
        path = export_root / "batches" / child_id / "manifest.json"
        manifest = _read_json(path)
        if manifest.get("export_batch_id") != child_id or manifest.get("logical_export_job_id") != job_id:
            raise CleaningError("child_batch_identity_mismatch", f"child batch does not belong to logical job: {child_id}")
        child_hashes[child_id] = _sha256(path)
        children.append((path, manifest))
        for attempt in manifest.get("work_unit_attempts") or []:
            if not isinstance(attempt, dict):
                raise CleaningError("manifest_invalid", f"child attempt is invalid: {child_id}")
            key = (child_id, attempt.get("work_unit_attempt_id"))
            if key in attempts_by_identity:
                raise CleaningError("manifest_invalid", f"duplicate child attempt identity: {child_id}")
            attempts_by_identity[key] = attempt
        child_selected, child_source = validate_v3_manifest(
            path,
            manifest,
            report_ids,
            authoritative_work_units=authoritative,
            allow_non_usable_batch=True,
        )
        selected.extend(child_selected)
        source_manifests.append(child_source["source_manifest"])
        source_artifacts.extend(child_source["source_artifacts"])
        authoritative_units.extend(child_source["authoritative_work_units"])

    authoritative_attempt_ids: set[str] = set()
    consumed_attempt_ids: set[str] = set()
    unusable_attempt_ids: set[str] = set()
    eligible_statuses = {"success", "no_data", "skipped"}
    for work_unit_id, authority in authoritative.items():
        if not isinstance(authority, dict):
            raise CleaningError("logical_manifest_invalid", f"logical authority is invalid: {work_unit_id}")
        batch_id = authority.get("authoritative_export_batch_id")
        attempt_id = authority.get("authoritative_attempt_id")
        attempt = attempts_by_identity.get((batch_id, attempt_id))
        if attempt is None or attempt.get("work_unit_id") != work_unit_id:
            raise CleaningError("authoritative_attempt_missing", f"authoritative attempt is absent from child batches: {work_unit_id}")
        for field in ("report_id", "execution_status", "unit_requirement"):
            if authority.get(field) != attempt.get(field):
                raise CleaningError("authoritative_attempt_mismatch", f"authoritative {field} differs from child attempt: {work_unit_id}")
        authoritative_attempt_ids.add(attempt_id)
        if authority.get("report_id") in report_ids:
            (consumed_attempt_ids if authority.get("execution_status") in eligible_statuses else unusable_attempt_ids).add(attempt_id)
    selected_attempt_ids = {
        context["work_unit_attempt_id"]
        for _report_id, _report, metadata in selected
        for context in metadata["_work_unit_contexts"].values()
    }
    if selected_attempt_ids - consumed_attempt_ids:
        raise CleaningError("authoritative_attempt_mismatch", "row-producing attempt is not authoritative")
    excluded_attempt_ids = sorted({
        attempt.get("work_unit_attempt_id")
        for _path, child in children
        for attempt in child.get("work_unit_attempts") or []
        if attempt.get("work_unit_attempt_id") and attempt.get("work_unit_attempt_id") not in authoritative_attempt_ids
    })
    source_status = latest.get("logical_job_status")
    if source_status == "success":
        package_status = "success" if not unusable_attempt_ids else "partial"
    elif source_status in {"partial", "blocked"}:
        package_status = source_status
    else:
        package_status = "failed"
    logical_input = {
        "schema_version": "logical_cleaning_package_manifest_v2",
        "cleaning_package_id": None,
        "source_logical_export_job_id": job_id,
        "source_logical_job_manifest": {
            "relative_path": latest_path.relative_to(export_root).as_posix(),
            "sha256": _sha256(latest_path),
            "manifest_version": latest["manifest_version"],
        },
        "source_logical_job_status": source_status,
        "cleaning_package_status": package_status,
        "consumed_export_batch_ids": child_ids,
        "consumed_authoritative_work_unit_attempt_ids": sorted(consumed_attempt_ids),
        "unusable_authoritative_work_unit_attempt_ids": sorted(unusable_attempt_ids),
        "excluded_non_authoritative_attempt_ids": excluded_attempt_ids,
        "incomplete_required_work_units": latest.get("incomplete_required_work_units", []),
    }
    return {
        "latest_path": latest_path,
        "latest_manifest": latest,
        "latest_sha256": _sha256(latest_path),
        "children": children,
        "child_hashes": child_hashes,
        "selected": selected,
        "context": {
            "input_mode": "logical_export_job_id",
            "schema_version": "cleaning_batch_manifest_v3",
            "cleaning_package_status": package_status,
            "source_logical_export_job_id": job_id,
            "source_logical_job_manifest_version": latest["manifest_version"],
            "source_logical_job_manifest_path": str(latest_path.resolve()),
            "source_logical_job_manifest_sha256": _sha256(latest_path),
            "source_logical_job_status": source_status,
            "created_at_utc": latest["updated_at_utc"],
            "source_batch_status": None,
            "is_complete_logical_result": source_status == "success" and package_status == "success",
            "consumed_export_batch_ids": child_ids,
            "consumed_authoritative_work_unit_attempt_ids": sorted(consumed_attempt_ids),
            "unusable_authoritative_work_unit_attempt_ids": sorted(unusable_attempt_ids),
            "excluded_non_authoritative_attempt_ids": excluded_attempt_ids,
            "incomplete_required_work_units": latest.get("incomplete_required_work_units", []),
            "logical_input": logical_input,
            "source_context": {
                "export_root": export_root,
                "source_manifests": source_manifests,
                "source_artifacts": source_artifacts,
                "authoritative_work_units": authoritative_units,
                "created_at_utc": latest["updated_at_utc"],
            },
        },
    }


def load_logical_job(export_root: Path, job_id: str, report_ids: list[str]) -> dict[str, Any]:
    if not UUID.fullmatch(job_id):
        raise CleaningError("logical_export_job_id_invalid", "logical export job ID is invalid")
    return _load_logical_job(export_root, job_id, report_ids)
