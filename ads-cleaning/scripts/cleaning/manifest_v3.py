"""Qualification gates and parser adapter for immutable export v3 Artifacts."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .conversion import _date_value, _required_string, _seller_time_context, _utc_datetime_value
from .errors import CleaningError
from .files import _sha256
SCHEMA = "export_batch_manifest_v3"
ACCEPTED_BATCH_STATUSES = {"success", "partial"}
MONEY_SNAPSHOT_REPORTS = {
    "gmvmax_campaign_hourly_performance",
    "gmvmax_campaign_performance_interval",
    "gmvmax_campaign_daily_performance",
    "gmvmax_campaign_product_daily_performance",
    "gmvmax_campaign_current_configuration_snapshot",
    "gmvmax_campaign_upgrade_session_snapshot",
}
CAMPAIGN_SNAPSHOT_REPORTS = {
    "gmvmax_campaign_hourly_performance",
    "gmvmax_campaign_current_configuration_snapshot",
    "gmvmax_campaign_performance_interval",
    "gmvmax_campaign_daily_performance",
    "gmvmax_campaign_product_daily_performance",
    "gmvmax_campaign_change_log",
    "gmvmax_campaign_recommendation_snapshot",
    "gmvmax_campaign_upgrade_session_snapshot",
}
ACCOUNT_SNAPSHOT_REPORTS = {"advertiser_account_status_snapshot"}
DYNAMIC_ENUMERATION_REPORTS = {
    "gmvmax_campaign_hourly_performance",
    "gmvmax_campaign_product_performance",
    "gmvmax_campaign_product_daily_performance",
    "gmvmax_campaign_product_creative_performance",
    "gmvmax_campaign_product_creative_daily_performance",
}
ARTIFACT_ID = re.compile(r"^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SOURCE_METADATA_FIELDS = {
    "campaign_id", "campaign_name_observed", "product_id", "product_name_observed",
    "metric_date", "official_total_count", "segment_start_date", "segment_end_date", "currency",
}


def _universe_status(report: dict[str, Any]) -> str | None:
    universes = report.get("campaign_universes") or []
    values = {item.get("universe_completeness_status") for item in universes if isinstance(item, dict)}
    values.discard(None)
    if len(values) > 1:
        raise CleaningError("campaign_universe_conflict", f"report has conflicting universe completeness: {report.get('report_id')}")
    return next(iter(values), None)


def _identity(manifest: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    request = manifest.get("request") or {}
    shop = manifest.get("shop") or {}
    advertiser = manifest.get("selected_advertiser") or {}
    for value, field in [
        (manifest.get("export_batch_id"), "export_batch_id"),
        (request.get("start_date"), "request.start_date"),
        (request.get("end_date"), "request.end_date"),
        (shop.get("provider_id"), "shop.provider_id"),
        (shop.get("shop_alias"), "shop.shop_alias"),
        (shop.get("seller_id"), "shop.seller_id"),
    ]:
        _required_string(value, field)
    _seller_time_context(shop)
    if _date_value(request["start_date"], "request.start_date") > _date_value(request["end_date"], "request.end_date"):
        raise CleaningError("invalid_requested_range", "request start_date is after end_date")
    if request.get("shop_alias") != shop.get("shop_alias"):
        raise CleaningError("shop_identity_mismatch", "request shop differs from Manifest shop identity")
    return request, shop, advertiser


def _manifest_relative_path(manifest_path: Path, export_root: Path, batch_id: str) -> str:
    expected = export_root / "batches" / batch_id / "manifest.json"
    if manifest_path.resolve() != expected.resolve():
        raise CleaningError("source_manifest_path_invalid", "v3 export Manifest is outside its immutable batch path")
    return expected.relative_to(export_root).as_posix()


def _artifact_file(export_root: Path, batch_id: str, artifact: dict[str, Any]) -> tuple[Path, str]:
    artifact_id = str(artifact.get("artifact_id") or "")
    relative = str(artifact.get("relative_path") or "")
    parts = relative.split("/")
    if not ARTIFACT_ID.fullmatch(artifact_id) or not relative or "\\" in relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise CleaningError("artifact_invalid", "v3 Artifact identity or path is invalid")
    if len(parts) < 5 or parts[0] != "files" or parts[-3] != artifact.get("report_id") or parts[-2] != artifact_id or not re.fullmatch(r"source\.[a-z0-9]{1,10}", parts[-1]):
        raise CleaningError("artifact_invalid", "v3 Artifact storage path is invalid")
    batch_root = export_root / "batches" / batch_id
    path = batch_root.joinpath(*relative.split("/"))
    if not path.is_file():
        raise CleaningError("source_file_missing", f"source Artifact is missing: {path}")
    expected_hash = str(artifact.get("sha256") or "").lower()
    if not SHA256.fullmatch(expected_hash) or _sha256(path) != expected_hash:
        raise CleaningError("source_hash_mismatch", f"source Artifact hash differs from Manifest: {path}")
    if artifact.get("byte_size") != path.stat().st_size:
        raise CleaningError("source_size_mismatch", f"source Artifact size differs from Manifest: {path}")
    return path, f"batches/{batch_id}/{relative}"


def _report_context(manifest: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    return {
        "logical_export_job_id": manifest.get("logical_export_job_id"),
        "batch_status": manifest.get("batch_status"),
        "report_campaign_universe_policy": report.get("report_campaign_universe_policy"),
        "universe_completeness_status": _universe_status(report),
        "discovery_status": report.get("discovery_status"),
        "universe_snapshot_id": report.get("universe_snapshot_id"),
        "source_filters": report.get("source_filters") or [],
        "relation_semantics": report.get("relation_semantics"),
        "universe_limitations": sorted({
            limitation
            for limitations in [
                *((universe.get("universe_limitations") or []) for universe in report.get("campaign_universes") or [] if isinstance(universe, dict)),
                (report.get("relationship_coverage") or {}).get("universe_limitations") or [],
            ]
            for limitation in limitations
        }),
        "captured_at_utc": next((universe.get("captured_at_utc") for universe in report.get("campaign_universes") or [] if isinstance(universe, dict) and universe.get("captured_at_utc")), None),
        "checked_campaign_count": (report.get("relationship_coverage") or {}).get("checked_campaign_count"),
        "checked_product_count": (report.get("relationship_coverage") or {}).get("checked_product_count"),
    }


def _validate_report_contract(report_id: str, report: dict[str, Any]) -> None:
    if report_id in DYNAMIC_ENUMERATION_REPORTS:
        if report.get("discovery_status") != "complete":
            raise CleaningError("source_discovery_incomplete", f"source discovery is incomplete: {report_id}")
        _required_string(report.get("universe_snapshot_id"), "report.universe_snapshot_id")
        _utc_datetime_value(report.get("enumeration_completed_at_utc"), "report.enumeration_completed_at_utc")
        if not isinstance(report.get("planned_coverage_unit_count"), int) or report["planned_coverage_unit_count"] < 0:
            raise CleaningError("planned_coverage_invalid", f"planned coverage is invalid: {report_id}")
        if not isinstance(report.get("source_filters"), list):
            raise CleaningError("source_filters_invalid", f"source filters are invalid: {report_id}")
        if report_id == "gmvmax_campaign_product_creative_performance":
            if report.get("source_filters") or report.get("relationship_class") != "observed_in_interval":
                raise CleaningError("creative_relationship_semantics_invalid", "creative relationship contract is invalid")
            coverage = report.get("relationship_coverage")
            if not isinstance(coverage, dict) or coverage.get("source_filters") or coverage.get("excluded_statuses") or coverage.get("pagination_complete") is not True:
                raise CleaningError("creative_relationship_coverage_invalid", "creative relationship coverage is invalid")
            total, collected = coverage.get("official_total_count"), coverage.get("collected_count")
            if not isinstance(total, int) or total < 0 or collected != total or any(not isinstance(coverage.get(field), int) or coverage[field] < 0 for field in ("checked_campaign_count", "checked_product_count")) or coverage.get("universe_completeness_status") != "complete_within_source_contract" or not isinstance(coverage.get("universe_limitations"), list):
                raise CleaningError("creative_relationship_coverage_invalid", "creative relationship count or universe is invalid")
        if report_id == "gmvmax_campaign_product_creative_daily_performance":
            if report.get("source_filters") or report.get("relationship_class") != "observed_on_metric_date" or report.get("relation_semantics") != "returned_by_date_parameterized_source_query":
                raise CleaningError("creative_relationship_semantics_invalid", "daily creative relationship contract is invalid")
            coverage = report.get("relationship_coverage")
            fields = ("checked_campaign_count", "checked_campaign_date_count", "checked_campaign_product_date_count", "official_total_count", "download_verified_count")
            if not isinstance(coverage, dict) or coverage.get("source_filters") or coverage.get("excluded_statuses") or any(not isinstance(coverage.get(field), int) or coverage[field] < 0 for field in fields) or coverage.get("universe_completeness_status") != "complete_within_source_contract" or not isinstance(coverage.get("universe_limitations"), list):
                raise CleaningError("creative_relationship_coverage_invalid", "daily creative relationship coverage is invalid")
            if report.get("status") == "success" and (coverage.get("download_count_complete") is not True or coverage.get("download_verified_count") != coverage.get("official_total_count")):
                raise CleaningError("creative_relationship_coverage_invalid", "successful daily creative report lacks complete official downloads")


def _validate_file_contract(report_id: str, metadata: dict[str, Any], contexts: dict[str, dict[str, Any]], request: dict[str, Any]) -> None:
    if report_id in CAMPAIGN_SNAPSHOT_REPORTS:
        if metadata.get("file_kind") != "api_snapshot":
            raise CleaningError("source_file_kind_invalid", f"campaign source requires api_snapshot: {report_id}")
        _required_string(metadata.get("source_id"), "artifact.source_id")
        _utc_datetime_value(metadata.get("captured_at_utc"), "artifact.captured_at_utc")
        if report_id in MONEY_SNAPSHOT_REPORTS:
            _required_string(metadata.get("currency"), "artifact.currency")
    if report_id in ACCOUNT_SNAPSHOT_REPORTS:
        if metadata.get("file_kind") != "api_snapshot":
            raise CleaningError("source_file_kind_invalid", f"account source requires api_snapshot: {report_id}")
        _required_string(metadata.get("source_id"), "artifact.source_id")
        _utc_datetime_value(metadata.get("captured_at_utc"), "artifact.captured_at_utc")
        _required_string(metadata.get("currency"), "artifact.currency")
    if report_id == "gmvmax_campaign_product_creative_daily_performance":
        campaign_id = _required_string(metadata.get("campaign_id"), "artifact.campaign_id")
        product_id = _required_string(metadata.get("product_id"), "artifact.product_id")
        metric_date = _date_value(metadata.get("metric_date"), "artifact.metric_date")
        if metric_date < _date_value(request["start_date"], "request.start_date") or metric_date > _date_value(request["end_date"], "request.end_date"):
            raise CleaningError("file_metric_date_invalid", "daily creative Artifact date is outside requested range")
        if metadata.get("generated_file") is not False or metadata.get("file_kind") != "official_export" or not metadata.get("official_filename") or not isinstance(metadata.get("official_total_count"), int) or metadata["official_total_count"] <= 0:
            raise CleaningError("source_file_kind_invalid", "daily creative Artifact contract is invalid")
        if any(str(context.get("campaign_id")) != campaign_id or str(context.get("product_id")) != product_id or context.get("metric_date") != metric_date for context in contexts.values()):
            raise CleaningError("work_unit_file_binding_invalid", "daily creative Artifact identity differs from its work unit")
    if report_id == "shop_product_daily_performance":
        start_date = _date_value(request["start_date"], "request.start_date")
        end_date = _date_value(request["end_date"], "request.end_date")
        if metadata.get("generated_file") is not False or metadata.get("file_kind") != "api_snapshot":
            raise CleaningError("source_file_kind_invalid", "daily product Artifact requires an immutable API snapshot")
        if _required_string(metadata.get("source_id"), "artifact.source_id") != "seller_product_analytics_daily_v2":
            raise CleaningError("source_file_kind_invalid", "daily product API Artifact source ID is unsupported")
        _utc_datetime_value(metadata.get("captured_at_utc"), "artifact.captured_at_utc")
        if _required_string(metadata.get("currency"), "artifact.currency") != "PHP":
            raise CleaningError("currency_inconsistent", "daily product API Artifact must be PHP")
        if any(_date_value(context.get("metric_date"), "work_unit.metric_date") < start_date or _date_value(context.get("metric_date"), "work_unit.metric_date") > end_date or context.get("campaign_id") is not None or context.get("product_id") is not None for context in contexts.values()):
            raise CleaningError("work_unit_file_binding_invalid", "daily product API Artifact differs from its shop-date work units")


def validate_v3_manifest(
    manifest_path: Path,
    manifest: dict[str, Any],
    report_ids: list[str],
    *,
    authoritative_work_units: dict[str, dict[str, Any]] | None = None,
    allow_non_usable_batch: bool = False,
) -> tuple[list[tuple[str, dict[str, Any], dict[str, Any]]], dict[str, Any]]:
    if manifest.get("schema_version") != SCHEMA:
        raise CleaningError("unknown_export_contract_version", "Manifest is not export_batch_manifest_v3")
    if manifest.get("storage_contract") != {"contract_id": "export_storage_contract", "contract_version": "1.0.0"}:
        raise CleaningError("export_storage_contract_mismatch", "v3 export storage contract differs")
    if not allow_non_usable_batch and manifest.get("batch_status") not in ACCEPTED_BATCH_STATUSES:
        raise CleaningError("manifest_not_usable", "Manifest is not a usable export_batch_manifest_v3")
    created = _utc_datetime_value(manifest.get("created_at_utc"), "manifest.created_at_utc")
    published = _utc_datetime_value(manifest.get("published_at_utc"), "manifest.published_at_utc")
    if created > published:
        raise CleaningError("manifest_time_invalid", "v3 export Manifest creation follows publication")
    request, _shop, advertiser = _identity(manifest)
    batch_id = manifest["export_batch_id"]
    export_root = manifest_path.resolve().parents[2]
    manifest_relative = _manifest_relative_path(manifest_path, export_root, batch_id)

    reports = manifest.get("reports")
    attempts = manifest.get("work_unit_attempts")
    artifacts_raw = manifest.get("artifacts")
    if not isinstance(reports, list) or not isinstance(attempts, list) or not isinstance(artifacts_raw, list):
        raise CleaningError("manifest_invalid", "v3 reports, work-unit attempts and Artifacts must be arrays")
    by_report = {item.get("report_id"): item for item in reports if isinstance(item, dict)}
    attempts_by_id: dict[str, dict[str, Any]] = {}
    attempts_by_work_unit: dict[str, dict[str, Any]] = {}
    for attempt in attempts:
        if not isinstance(attempt, dict):
            raise CleaningError("manifest_invalid", "v3 work-unit attempt must be an object")
        attempt_id = _required_string(attempt.get("work_unit_attempt_id"), "work_unit_attempt_id")
        work_unit_id = _required_string(attempt.get("work_unit_id"), "work_unit_id")
        if attempt_id in attempts_by_id or work_unit_id in attempts_by_work_unit:
            raise CleaningError("manifest_invalid", "v3 batch contains duplicate work-unit identity")
        attempts_by_id[attempt_id] = attempt
        attempts_by_work_unit[work_unit_id] = attempt

    artifacts: dict[str, tuple[dict[str, Any], Path, str]] = {}
    for artifact in artifacts_raw:
        if not isinstance(artifact, dict) or not isinstance(artifact.get("source_metadata"), dict) or set(artifact["source_metadata"]) - SOURCE_METADATA_FIELDS:
            raise CleaningError("artifact_invalid", "v3 Artifact metadata is invalid")
        if _utc_datetime_value(artifact.get("captured_at_utc"), "artifact.captured_at_utc") > published:
            raise CleaningError("artifact_time_invalid", "v3 Artifact capture follows Manifest publication")
        artifact_id = _required_string(artifact.get("artifact_id"), "artifact_id")
        if artifact_id in artifacts:
            raise CleaningError("artifact_invalid", "v3 Artifact identity is duplicated")
        path, root_relative = _artifact_file(export_root, batch_id, artifact)
        artifacts[artifact_id] = (artifact, path, root_relative)

    bound_artifacts: set[str] = set()
    for attempt in attempts_by_id.values():
        bindings = attempt.get("artifact_bindings")
        if not isinstance(bindings, list):
            raise CleaningError("artifact_binding_invalid", "v3 attempt Artifact bindings are invalid")
        local: set[str] = set()
        for binding in bindings:
            artifact_id = (binding or {}).get("artifact_id") if isinstance(binding, dict) else None
            if artifact_id not in artifacts or artifact_id in local or artifacts[artifact_id][0].get("report_id") != attempt.get("report_id") or binding.get("relation_role") not in {"primary_source", "supplemental_source"}:
                raise CleaningError("artifact_binding_invalid", "v3 attempt Artifact binding is invalid")
            local.add(artifact_id)
            bound_artifacts.add(artifact_id)
        if attempt.get("execution_status") == "success" and not local:
            raise CleaningError("successful_work_unit_artifact_missing", "successful work unit lacks an Artifact")
        if attempt.get("execution_status") == "no_data" and local:
            raise CleaningError("no_data_artifact_forbidden", "no-data work unit cannot bind an Artifact")
    if bound_artifacts != set(artifacts):
        raise CleaningError("unbound_artifact_forbidden", "v3 export Manifest contains an unbound Artifact")

    selected: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    selected_artifact_ids: set[str] = set()
    authoritative_units: list[dict[str, Any]] = []
    for report_id in report_ids:
        report = by_report.get(report_id)
        if not report:
            raise CleaningError("report_missing", f"report is absent: {report_id}")
        if report.get("owner_type") == "advertiser":
            advertiser_id = _required_string(advertiser.get("advertiser_id"), "selected_advertiser.advertiser_id")
            if str(report.get("owner_id")) != advertiser_id:
                raise CleaningError("report_owner_mismatch", f"report owner differs from selected advertiser: {report_id}")
        elif report.get("owner_type") != "shop":
            raise CleaningError("report_owner_mismatch", f"unsupported report owner: {report_id}")
        _validate_report_contract(report_id, report)

        qualified: dict[str, dict[str, Any]] = {}
        for work_unit_id, attempt in attempts_by_work_unit.items():
            if attempt.get("report_id") != report_id or attempt.get("execution_status") not in {"success", "no_data", "skipped"}:
                continue
            if authoritative_work_units is not None:
                authority = authoritative_work_units.get(work_unit_id)
                if not authority or authority.get("authoritative_export_batch_id") != batch_id:
                    continue
                if authority.get("authoritative_attempt_id") != attempt.get("work_unit_attempt_id"):
                    raise CleaningError("authoritative_attempt_mismatch", f"logical authority differs from child attempt: {work_unit_id}")
            qualified[work_unit_id] = dict(attempt)
        eligible = {work_unit_id: attempt for work_unit_id, attempt in qualified.items() if attempt.get("execution_status") == "success"}

        covered: set[str] = set()
        for artifact_id, (artifact, path, root_relative) in artifacts.items():
            if artifact.get("report_id") != report_id:
                continue
            contexts: dict[str, dict[str, Any]] = {}
            for work_unit_id, attempt in eligible.items():
                bindings = attempt.get("artifact_bindings")
                if not isinstance(bindings, list):
                    raise CleaningError("artifact_binding_invalid", "v3 attempt Artifact bindings are invalid")
                if any(binding.get("artifact_id") == artifact_id for binding in bindings if isinstance(binding, dict)):
                    context = dict(attempt)
                    context["_export_batch_id"] = batch_id
                    contexts[work_unit_id] = context
            if not contexts:
                continue
            covered.update(contexts)
            metadata = dict(artifact["source_metadata"])
            metadata.update({
                "path": str(path),
                "lineage_path": root_relative,
                "sha256": artifact["sha256"],
                "generated_file": artifact["generated_file"],
                "file_kind": artifact["file_kind"],
                "source_id": artifact.get("source_id"),
                "captured_at_utc": artifact["captured_at_utc"],
                "official_filename": artifact.get("official_filename"),
                "currency": metadata.get("currency") or report.get("currency"),
                "_artifact": {
                    "artifact_id": artifact_id,
                    "export_batch_id": batch_id,
                    "report_id": report_id,
                    "relative_path": root_relative,
                    "sha256": artifact["sha256"],
                    "captured_at_utc": artifact["captured_at_utc"],
                },
                "_work_unit_contexts": contexts,
                "_report_context": _report_context(manifest, report),
            })
            if len(contexts) == 1:
                context = next(iter(contexts.values()))
                pagination = context.get("pagination") or {}
                for field in ("campaign_id", "campaign_name_observed", "product_id", "product_name_observed", "metric_date"):
                    metadata.setdefault(field, context.get(field))
                metadata.setdefault("official_total_count", pagination.get("official_total_count"))
            _validate_file_contract(report_id, metadata, contexts, request)
            selected.append((report_id, report, metadata))
            selected_artifact_ids.add(artifact_id)

        if set(eligible) != covered:
            missing = sorted(set(eligible) - covered)
            raise CleaningError("successful_work_unit_artifact_missing", f"successful work units lack Artifacts: {','.join(missing)}")
        for work_unit_id, attempt in sorted(qualified.items()):
            artifact_ids = sorted({binding["artifact_id"] for binding in attempt.get("artifact_bindings") or [] if binding.get("artifact_id") in selected_artifact_ids})
            authoritative_units.append({
                "work_unit_id": work_unit_id,
                "authoritative_attempt_id": attempt["work_unit_attempt_id"],
                "export_batch_id": batch_id,
                "report_id": report_id,
                "execution_status": attempt["execution_status"],
                "source_artifact_ids": artifact_ids,
            })

    source_context = {
        "export_root": export_root,
        "source_manifest": {"export_batch_id": batch_id, "relative_path": manifest_relative, "sha256": _sha256(manifest_path)},
        "source_artifacts": [metadata["_artifact"] for _report_id, _report, metadata in selected],
        "authoritative_work_units": authoritative_units,
        "created_at_utc": manifest.get("published_at_utc"),
    }
    return selected, source_context


def batch_package_context(manifest: dict[str, Any], source_context: dict[str, Any]) -> dict[str, Any]:
    status = manifest["batch_status"]
    return {
        "input_mode": "export_batch_id",
        "schema_version": "cleaning_batch_manifest_v3",
        "cleaning_package_status": "success" if status == "success" else "partial",
        "source_logical_export_job_id": manifest.get("logical_export_job_id"),
        "source_logical_job_status": None,
        "source_batch_status": status,
        "created_at_utc": source_context["created_at_utc"],
        "is_complete_logical_result": False,
        "consumed_export_batch_ids": [manifest["export_batch_id"]],
        "incomplete_required_work_units": (manifest.get("checkpoint") or {}).get("incomplete_required_work_unit_ids", []),
        "source_context": source_context,
    }
