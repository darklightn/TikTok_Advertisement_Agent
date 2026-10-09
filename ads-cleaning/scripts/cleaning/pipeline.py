"""Cleaning batch orchestration."""
from __future__ import annotations
import json
import uuid
from pathlib import Path
from typing import Any
from .contracts import cleanable_report_ids, product_columns
from .errors import CleaningError
from .files import _read_json, _sha256
from .logical_job import load_logical_job
from .manifest_v3 import batch_package_context, validate_v3_manifest
from .output import _materialize_batch
from .parsers.generic import _parse_file
from .records import CLEANING_VERSION
from .dashboards import DASHBOARD_CONTRACT_VERSION


def _validate_cleanable_reports(report_ids: list[str], model_path: Path) -> None:
    supported = cleanable_report_ids(_read_json(model_path))
    for report_id in report_ids:
        if report_id not in supported:
            raise CleaningError("unsupported_report", f"unsupported report: {report_id}")


def _work_unit_for_row(file_meta: dict[str, Any], row: dict[str, Any]) -> dict[str, Any] | None:
    contexts = file_meta.get("_work_unit_contexts") or {}
    if not contexts:
        return None
    candidates = []
    for work_unit_id, context in contexts.items():
        campaign_id = context.get("campaign_id")
        metric_date = context.get("metric_date")
        if campaign_id is not None and str(row.get("campaign_id") or "") != str(campaign_id):
            continue
        if metric_date is not None and str(row.get("metric_date") or "") != str(metric_date):
            continue
        candidates.append((work_unit_id, context))
    if len(candidates) != 1:
        raise CleaningError("row_work_unit_ambiguous", "cleaned row cannot be bound to exactly one authoritative work unit")
    work_unit_id, context = candidates[0]
    return {"work_unit_id": work_unit_id, **context}


def _apply_execution_lineage(row: dict[str, Any], file_meta: dict[str, Any], logical_status: str | None) -> None:
    report_context = file_meta.get("_report_context") or {}
    unit = _work_unit_for_row(file_meta, row)
    row.update({
        "logical_export_job_id": report_context.get("logical_export_job_id"),
        "work_unit_id": unit.get("work_unit_id") if unit else None,
        "coverage_unit_key": unit.get("coverage_unit_key") if unit else None,
        "authoritative_attempt_id": unit.get("work_unit_attempt_id") if unit else None,
        "batch_status": report_context.get("batch_status"),
        "logical_job_status": logical_status,
        "report_campaign_universe_policy": report_context.get("report_campaign_universe_policy"),
        "universe_completeness_status": report_context.get("universe_completeness_status"),
        "relation_semantics": report_context.get("relation_semantics"),
        "source_filters": json.dumps(report_context.get("source_filters") or [], ensure_ascii=False, separators=(",", ":")),
        "universe_limitations": json.dumps(report_context.get("universe_limitations") or [], ensure_ascii=False, separators=(",", ":")),
        "relation_captured_at_utc": report_context.get("captured_at_utc"),
        "checked_campaign_count": report_context.get("checked_campaign_count"),
        "checked_product_count": report_context.get("checked_product_count"),
    })


def _clean_sources(
    sources: list[tuple[Path, dict[str, Any], list[tuple[str, dict[str, Any], dict[str, Any]]]]],
    report_ids: list[str], output_root: Path, model_path: Path, baseline_path: Path,
    package_context: dict[str, Any] | None = None, package_seed: str | None = None,
) -> dict[str, Any]:
    if len(report_ids) != len(set(report_ids)):
        raise CleaningError("duplicate_report_id", "report IDs must be unique")
    model = _read_json(model_path)
    baseline = _read_json(baseline_path)
    resolved_product_columns = product_columns(model, model_path) if "product_analytics_performance" in report_ids else []
    source_hashes = {str(path.resolve()): _sha256(path) for path, _manifest, _selected in sources}
    source_context = (package_context or {}).get("source_context") or {}
    if package_seed is not None:
        seed = package_seed
    elif source_context.get("source_manifest"):
        source = source_context["source_manifest"]
        seed = f"{source['export_batch_id']}|{source['sha256']}"
    else:
        seed = "|".join(f"{path}:{digest}" for path, digest in sorted(source_hashes.items()))
    batch_name = f"{CLEANING_VERSION}|dashboard={DASHBOARD_CONTRACT_VERSION}|{seed}|{','.join(sorted(report_ids))}"
    report_contract_versions = sorted(
        f"{dataset['report_id']}@{dataset['contract_version']}"
        for dataset in model["datasets"]
        if dataset.get("report_id") in report_ids and dataset.get("contract_version")
    )
    if report_contract_versions:
        batch_name += f"|{','.join(report_contract_versions)}"
    batch_id = str(uuid.uuid5(uuid.NAMESPACE_URL, batch_name))
    collected: dict[str, list[dict[str, Any]]] = {}
    file_qa = []
    field_dictionary_overrides: dict[str, list[dict[str, Any]]] = {}
    dataset_source_artifacts: dict[str, set[str]] = {}
    selected_all = []
    source_file_hashes_before = {}
    logical_status = package_context.get("source_logical_job_status") if package_context else None
    for _manifest_path, manifest, selected in sources:
        selected_all.extend(selected)
        source_file_hashes_before.update({item[2]["path"]: _sha256(Path(item[2]["path"])) for item in selected})
    selected_by_report: dict[str, list[tuple[dict[str, Any], str, dict[str, Any], dict[str, Any]]]] = {}
    for _manifest_path, manifest, selected in sources:
        for report_id, report, file_meta in selected:
            selected_by_report.setdefault(report_id, []).append((manifest, report_id, report, file_meta))
    failed_reports: list[dict[str, Any]] = []
    successful_report_ids: list[str] = []
    for requested_report_id in report_ids:
        local_collected: dict[str, list[dict[str, Any]]] = {}
        local_file_qa: list[dict[str, Any]] = []
        local_overrides: dict[str, list[dict[str, Any]]] = {}
        local_artifacts: dict[str, set[str]] = {}
        try:
            for manifest, report_id, report, file_meta in selected_by_report.get(requested_report_id, []):
                parsed_outputs = _parse_file(manifest, report_id, report, file_meta, model, baseline, batch_id, resolved_product_columns)
                if isinstance(parsed_outputs, tuple):
                    parsed_outputs = [parsed_outputs]
                for dataset, rows, qa in parsed_outputs:
                    artifact = file_meta.get("_artifact")
                    if artifact:
                        local_artifacts.setdefault(dataset, set()).add(artifact["artifact_id"])
                    for row in rows:
                        _apply_execution_lineage(row, file_meta, logical_status)
                    override = qa.pop("_field_dictionary", None)
                    if override:
                        if dataset in local_overrides and local_overrides[dataset] != override:
                            raise CleaningError("field_dictionary_mismatch", f"source field dictionary differs within dataset: {dataset}")
                        local_overrides[dataset] = override
                    local_collected.setdefault(dataset, []).extend(rows)
                    local_file_qa.append(qa)
        except CleaningError as exc:
            if exc.code != "report_schema_version_unsupported":
                raise
            failure = dict(exc.details)
            failure.setdefault("report_id", requested_report_id)
            failure.setdefault("code", exc.code)
            failed_reports.append(failure)
            continue
        successful_report_ids.append(requested_report_id)
        for dataset, rows in local_collected.items():
            collected.setdefault(dataset, []).extend(rows)
        file_qa.extend(local_file_qa)
        for dataset, override in local_overrides.items():
            if dataset in field_dictionary_overrides and field_dictionary_overrides[dataset] != override:
                raise CleaningError("field_dictionary_mismatch", f"source field dictionary differs within dataset: {dataset}")
            field_dictionary_overrides[dataset] = override
        for dataset, artifact_ids in local_artifacts.items():
            dataset_source_artifacts.setdefault(dataset, set()).update(artifact_ids)
    if not successful_report_ids:
        raise CleaningError(
            "all_reports_schema_unsupported",
            "all requested reports were isolated because their headers are unsupported",
            {"failed_reports": failed_reports},
        )
    conflicts = []
    for dataset, rows in list(collected.items()):
        by_key: dict[str, dict[str, Any]] = {}
        for row in rows:
            key = row["record_key"]
            prior = by_key.get(key)
            if prior is None:
                by_key[key] = row
            elif prior["record_content_hash"] != row["record_content_hash"]:
                conflicts.append({"dataset": dataset, "record_key": key, "content_hashes": sorted({prior["record_content_hash"], row["record_content_hash"]})})
        if conflicts:
            continue
        collected[dataset] = list(by_key.values())
    if conflicts:
        raise CleaningError("cross_unit_record_conflict", "same record key has conflicting authoritative content")
    all_record_keys = [row["record_key"] for rows in collected.values() for row in rows]
    source_keys_by_dataset = {name: [row["source_row_key"] for row in rows] for name, rows in collected.items()}
    if any(len(keys) != len(set(keys)) for keys in source_keys_by_dataset.values()):
        raise CleaningError("source_row_key_duplicate", "duplicate source_row_key within one dataset")
    if source_file_hashes_before != {item[2]["path"]: _sha256(Path(item[2]["path"])) for item in selected_all}:
        raise CleaningError("source_changed_during_cleaning", "source file changed during cleaning")
    if source_hashes != {str(path.resolve()): _sha256(path) for path, _manifest, _selected in sources}:
        raise CleaningError("source_manifest_changed_during_cleaning", "source Manifest changed during cleaning")
    primary_manifest = sources[0][1]
    return _materialize_batch(
        report_ids, output_root, model, primary_manifest, batch_id,
        selected_all, collected, file_qa, field_dictionary_overrides, all_record_keys,
        package_context=package_context,
        dataset_source_artifacts=dataset_source_artifacts,
        successful_report_ids=sorted(successful_report_ids), failed_reports=failed_reports,
    )


def clean(manifest_path: Path, report_ids: list[str], output_root: Path, model_path: Path, baseline_path: Path) -> dict[str, Any]:
    _validate_cleanable_reports(report_ids, model_path)
    manifest = _read_json(manifest_path)
    if manifest.get("schema_version") != "export_batch_manifest_v3":
        raise CleaningError("manifest_schema_unsupported", "only export_batch_manifest_v3 is supported")
    selected, source_context = validate_v3_manifest(manifest_path, manifest, report_ids)
    context = batch_package_context(manifest, source_context)
    return _clean_sources([(manifest_path, manifest, selected)], report_ids, output_root, model_path, baseline_path, context)


def clean_logical_job(
    export_root: Path, logical_export_job_id: str, report_ids: list[str], output_root: Path,
    model_path: Path, baseline_path: Path,
) -> dict[str, Any]:
    _validate_cleanable_reports(report_ids, model_path)
    logical = load_logical_job(export_root, logical_export_job_id, report_ids)
    selected_by_batch: dict[str, list[tuple[str, dict[str, Any], dict[str, Any]]]] = {}
    for item in logical["selected"]:
        batch_id = next(iter(item[2]["_work_unit_contexts"].values())).get("_export_batch_id")
        if batch_id is None:
            raise CleaningError("child_batch_identity_missing", "selected source lacks child batch identity")
        selected_by_batch.setdefault(batch_id, []).append(item)
    sources = [(path, manifest, selected_by_batch.get(manifest["export_batch_id"], [])) for path, manifest in logical["children"]]
    package_seed = f"{logical_export_job_id}|{logical['latest_sha256']}"
    return _clean_sources(sources, report_ids, output_root, model_path, baseline_path, logical["context"], package_seed)
