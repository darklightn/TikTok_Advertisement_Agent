"""Machine validators for current immutable cleaning storage manifests."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import re
from typing import Any

from .errors import CleaningError


_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
_UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
_ARTIFACT = re.compile(r"^art_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _fail(code: str) -> None:
    raise CleaningError(code, code)


def _relative_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        _fail("storage_relative_path_invalid")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        _fail("storage_relative_path_invalid")
    return value


def _utc(value: Any, code: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        _fail(code)
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        _fail(code)


def validate_dataset_catalog_snapshot(value: Any) -> set[str]:
    if not isinstance(value, dict) or value.get("schema_version") != "dataset_catalog_v1" or not _SHA256.fullmatch(str(value.get("catalog_sha256", ""))):
        _fail("dataset_catalog_invalid")
    datasets = value.get("datasets")
    source_model = value.get("source_model")
    taxonomy = value.get("diagnostic_domain_taxonomy")
    aggregation_policy = value.get("safe_aggregation_policy")
    if not isinstance(datasets, list) or not isinstance(source_model, dict) or not _SHA256.fullmatch(str(source_model.get("sha256", ""))) or source_model.get("sha256_scope") != "UTF8_JSON_sorted_keys_compact" or aggregation_policy != {"explicit_field_semantics_only": True, "not_declared_behavior": "not_aggregatable", "derived_metric_behavior": "recompute_from_declared_inputs"} or not isinstance(taxonomy, list) or not taxonomy:
        _fail("dataset_catalog_invalid")
    domain_ids = [item.get("domain_id") for item in taxonomy if isinstance(item, dict)]
    if len(domain_ids) != len(taxonomy) or any(not isinstance(item, str) or not item for item in domain_ids) or len(domain_ids) != len(set(domain_ids)):
        _fail("dataset_catalog_invalid")
    names: list[str] = []
    for dataset in datasets:
        required = ("dataset_name", "report_id", "contract_version", "diagnostic_domains", "owner_type", "grain", "time_semantics", "record_key_fields", "partition_keys", "currency_applicability", "aggregation_semantics")
        if not isinstance(dataset, dict) or not all(dataset.get(field) is not None for field in required):
            _fail("dataset_catalog_invalid")
        if not isinstance(dataset["partition_keys"], list) or not dataset["partition_keys"] or not isinstance(dataset["record_key_fields"], list) or not dataset["record_key_fields"] or not isinstance(dataset["diagnostic_domains"], list) or not dataset["diagnostic_domains"] or any(item not in domain_ids for item in dataset["diagnostic_domains"]) or not isinstance(dataset["aggregation_semantics"], dict):
            _fail("dataset_catalog_invalid")
        names.append(dataset["dataset_name"])
    if len(names) != len(set(names)):
        _fail("dataset_catalog_duplicate_dataset")
    payload = dict(value)
    expected_hash = payload.pop("catalog_sha256")
    actual_hash = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    if actual_hash != expected_hash:
        _fail("dataset_catalog_hash_mismatch")
    return set(names)


def _catalog_binding(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != "dataset_catalog_binding_v1":
        _fail("dataset_catalog_binding_invalid")
    if not isinstance(value.get("catalog_version"), str) or not value["catalog_version"]:
        _fail("dataset_catalog_binding_invalid")
    if not _SHA256.fullmatch(str(value.get("content_sha256", ""))) or not _SHA256.fullmatch(str(value.get("file_sha256", ""))):
        _fail("dataset_catalog_binding_invalid")
    _relative_path(value.get("relative_path"))
    return value


def validate_cleaning_batch_manifest_v3(manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(manifest, dict) or manifest.get("schema_version") != "cleaning_batch_manifest_v3":
        _fail("cleaning_manifest_v3_invalid")
    if not _UUID.fullmatch(str(manifest.get("cleaning_batch_id", ""))) or manifest.get("cleaning_package_id") != manifest.get("cleaning_batch_id"):
        _fail("cleaning_manifest_v3_invalid")
    if "capability_ledger" in manifest:
        _fail("cleaning_batch_capability_ledger_forbidden")
    if any(field not in manifest for field in ("cleaning_batch_status", "source_logical_job_status", "qa_status")):
        _fail("cleaning_manifest_status_invalid")
    if manifest.get("cleaning_batch_status") not in {"success", "partial", "blocked", "failed"} or manifest.get("qa_status") != "passed":
        _fail("cleaning_manifest_status_invalid")
    if manifest.get("source_logical_job_status") is not None and manifest.get("source_logical_job_status") not in {"success", "partial", "blocked", "failed"}:
        _fail("cleaning_manifest_status_invalid")
    if manifest.get("qa_scope") not in {None, "published_outputs_only"}:
        _fail("cleaning_qa_scope_invalid")
    report_ids = manifest.get("report_ids")
    successful_report_ids = manifest.get("successful_report_ids")
    failed_reports = manifest.get("failed_reports")
    if successful_report_ids is not None or failed_reports is not None:
        if not isinstance(report_ids, list) or len(report_ids) != len(set(report_ids)) or any(not isinstance(item, str) or not item for item in report_ids):
            _fail("cleaning_report_result_invalid")
        if not isinstance(successful_report_ids, list) or len(successful_report_ids) != len(set(successful_report_ids)) or any(item not in report_ids for item in successful_report_ids):
            _fail("cleaning_report_result_invalid")
        if not isinstance(failed_reports, list):
            _fail("cleaning_report_result_invalid")
        failed_ids = [item.get("report_id") for item in failed_reports if isinstance(item, dict)]
        if len(failed_ids) != len(failed_reports) or len(failed_ids) != len(set(failed_ids)) or any(item not in report_ids for item in failed_ids):
            _fail("cleaning_report_result_invalid")
        if set(successful_report_ids) & set(failed_ids) or set(successful_report_ids) | set(failed_ids) != set(report_ids):
            _fail("cleaning_report_result_invalid")
    shop = manifest.get("shop")
    if not isinstance(shop, dict) or not isinstance(shop.get("shop_id"), str) or not shop["shop_id"] or "seller_id" in shop:
        _fail("cleaning_manifest_shop_identity_invalid")
    advertiser = manifest.get("selected_advertiser")
    if advertiser is not None and (
        not isinstance(advertiser, dict)
        or not isinstance(advertiser.get("advertiser_id"), str)
        or not advertiser["advertiser_id"]
        or not isinstance(advertiser.get("advertiser_name"), str)
        or not advertiser["advertiser_name"]
    ):
        _fail("cleaning_manifest_advertiser_identity_invalid")
    created = _utc(manifest.get("created_at_utc"), "cleaning_manifest_time_invalid")
    published = _utc(manifest.get("published_at_utc"), "cleaning_manifest_time_invalid")
    if created > published:
        _fail("cleaning_manifest_future_snapshot")
    storage = manifest.get("storage_contract")
    if not isinstance(storage, dict) or storage.get("contract_id") != "cleaning_storage_contract" or storage.get("contract_version") != "2.0.0" or not _SHA256.fullmatch(str(storage.get("sha256", ""))):
        _fail("cleaning_storage_contract_mismatch")
    _relative_path(storage.get("relative_path"))
    model = manifest.get("model")
    if not isinstance(model, dict) or model.get("schema_version") != "tiktok_cleaning_model_v1" or not isinstance(model.get("model_version"), str) or not model["model_version"] or not _SHA256.fullmatch(str(model.get("sha256", ""))) or model.get("sha256_scope") != "UTF8_JSON_sorted_keys_compact":
        _fail("cleaning_model_binding_invalid")
    catalog = _catalog_binding(manifest.get("dataset_catalog"))
    dataset_names = set(manifest.get("dataset_names") or [])
    if any(not isinstance(name, str) or not name for name in dataset_names):
        _fail("cleaning_dataset_names_invalid")

    source_manifests = manifest.get("source_manifests")
    source_artifacts = manifest.get("source_artifacts")
    outputs = manifest.get("outputs")
    work_units = manifest.get("authoritative_work_units")
    if not isinstance(source_manifests, list) or not source_manifests or not isinstance(source_artifacts, list) or not isinstance(work_units, list) or not work_units or not isinstance(outputs, list):
        _fail("cleaning_manifest_v3_invalid")
    source_batch_ids: set[str] = set()
    for source in source_manifests:
        if not isinstance(source, dict) or not _UUID.fullmatch(str(source.get("export_batch_id", ""))) or not _SHA256.fullmatch(str(source.get("sha256", ""))):
            _fail("source_manifest_invalid")
        path = _relative_path(source.get("relative_path"))
        if path != f"batches/{source['export_batch_id']}/manifest.json" or source["export_batch_id"] in source_batch_ids:
            _fail("source_manifest_invalid")
        source_batch_ids.add(source["export_batch_id"])
    artifacts: dict[str, dict[str, Any]] = {}
    for artifact in source_artifacts:
        artifact_id = str((artifact or {}).get("artifact_id", ""))
        if not _ARTIFACT.fullmatch(artifact_id) or artifact_id in artifacts:
            _fail("source_artifact_invalid")
        if not _UUID.fullmatch(str(artifact.get("export_batch_id", ""))) or not _SHA256.fullmatch(str(artifact.get("sha256", ""))):
            _fail("source_artifact_invalid")
        if not isinstance(artifact.get("report_id"), str) or not artifact["report_id"]:
            _fail("source_artifact_invalid")
        if artifact["export_batch_id"] not in source_batch_ids:
            _fail("source_artifact_invalid")
        source_path = _relative_path(artifact.get("relative_path"))
        source_parts = source_path.split("/")
        if source_parts[:2] != ["batches", artifact["export_batch_id"]] or len(source_parts) < 5 or source_parts[-2] != artifact_id or not re.fullmatch(r"source\.[a-z0-9]{1,10}", source_parts[-1]):
            _fail("source_artifact_machine_filename_invalid")
        if _utc(artifact.get("captured_at_utc"), "source_artifact_time_invalid") > published:
            _fail("source_artifact_future_snapshot")
        artifacts[artifact_id] = artifact

    bound_artifacts: set[str] = set()
    attempt_ids: set[str] = set()
    work_unit_ids: set[str] = set()
    for unit in work_units:
        if not isinstance(unit, dict) or not isinstance(unit.get("work_unit_id"), str) or not unit["work_unit_id"] or not _UUID.fullmatch(str(unit.get("authoritative_attempt_id", ""))) or not _UUID.fullmatch(str(unit.get("export_batch_id", ""))) or not isinstance(unit.get("report_id"), str) or not unit["report_id"] or unit.get("execution_status") not in {"success", "no_data", "skipped"}:
            _fail("authoritative_work_unit_invalid")
        if unit["authoritative_attempt_id"] in attempt_ids or unit["work_unit_id"] in work_unit_ids:
            _fail("authoritative_work_unit_duplicate")
        source_ids = unit.get("source_artifact_ids")
        if not isinstance(source_ids, list) or len(source_ids) != len(set(source_ids)) or any(item not in artifacts for item in source_ids) or (unit["execution_status"] == "success" and not source_ids) or (unit["execution_status"] in {"no_data", "skipped"} and source_ids):
            _fail("authoritative_work_unit_artifact_binding_invalid")
        if any(artifacts[item]["export_batch_id"] != unit["export_batch_id"] or artifacts[item]["report_id"] != unit["report_id"] for item in source_ids):
            _fail("authoritative_work_unit_artifact_binding_invalid")
        attempt_ids.add(unit["authoritative_attempt_id"])
        work_unit_ids.add(unit["work_unit_id"])
        bound_artifacts.update(source_ids)
    if bound_artifacts != set(artifacts):
        _fail("cleaning_unbound_source_artifact")
    for failure in failed_reports or []:
        if failure.get("code") != "report_schema_version_unsupported" or failure.get("source_artifact_id") not in artifacts:
            _fail("cleaning_failed_report_invalid")
        artifact = artifacts[failure["source_artifact_id"]]
        if artifact["report_id"] != failure["report_id"] or _relative_path(failure.get("source_file_relative_path")) != artifact["relative_path"]:
            _fail("cleaning_failed_report_invalid")
        if not _SHA256.fullmatch(str(failure.get("observed_header_sha256", ""))) or not isinstance(failure.get("compared_version"), str) or not failure["compared_version"]:
            _fail("cleaning_failed_report_invalid")
        differences = failure.get("differences")
        if not isinstance(differences, list) or not differences:
            _fail("cleaning_failed_report_invalid")
        columns = []
        for difference in differences:
            if not isinstance(difference, dict) or not isinstance(difference.get("column"), int) or difference["column"] < 1:
                _fail("cleaning_failed_report_invalid")
            if difference.get("expected") is not None and not isinstance(difference["expected"], str):
                _fail("cleaning_failed_report_invalid")
            if difference.get("actual") is not None and not isinstance(difference["actual"], str):
                _fail("cleaning_failed_report_invalid")
            columns.append(difference["column"])
        if len(columns) != len(set(columns)):
            _fail("cleaning_failed_report_invalid")

    paths: set[str] = set()
    output_ids: set[str] = set()
    for output in outputs:
        if not isinstance(output, dict) or not isinstance(output.get("output_id"), str) or not output["output_id"] or output["output_id"] in output_ids:
            _fail("cleaning_output_invalid")
        path = _relative_path(output.get("relative_path"))
        if path in paths:
            _fail("cleaning_output_path_duplicate")
        expected = f"batches/{manifest['cleaning_batch_id']}/tables/{output.get('dataset_name')}.csv"
        if path != expected or output.get("output_id") != output.get("dataset_name"):
            _fail("cleaning_output_machine_filename_invalid")
        if output.get("dataset_name") not in dataset_names or not _SHA256.fullmatch(str(output.get("sha256", ""))):
            _fail("cleaning_output_invalid")
        if not isinstance(output.get("row_count"), int) or output["row_count"] < 0:
            _fail("cleaning_output_invalid")
        source_ids = output.get("source_artifact_ids")
        if not isinstance(source_ids, list) or not source_ids or len(source_ids) != len(set(source_ids)) or any(item not in artifacts for item in source_ids):
            _fail("cleaning_source_artifact_binding_invalid")
        paths.add(path)
        output_ids.add(output["output_id"])
    dashboard_status = manifest.get("dashboard_status")
    dashboard_outputs = manifest.get("dashboard_outputs")
    if dashboard_status is None and dashboard_outputs is None:
        dashboard_outputs = []
    elif dashboard_status not in {"complete", "partial"} or not isinstance(dashboard_outputs, list):
        _fail("cleaning_dashboard_manifest_invalid")
    elif not isinstance(manifest.get("dashboard_contract_version"), str) or not manifest["dashboard_contract_version"]:
        _fail("cleaning_dashboard_manifest_invalid")
    dashboard_keys: set[tuple[str, str]] = set()
    for output in dashboard_outputs:
        if not isinstance(output, dict):
            _fail("cleaning_dashboard_manifest_invalid")
        key = (str(output.get("audience") or ""), str(output.get("table_name") or ""))
        if not all(key) or key in dashboard_keys or output.get("status") not in {"generated", "official_zero", "source_missing"}:
            _fail("cleaning_dashboard_manifest_invalid")
        dashboard_keys.add(key)
        if output["status"] == "source_missing":
            if not isinstance(output.get("missing_sources"), list) or not output["missing_sources"]:
                _fail("cleaning_dashboard_manifest_invalid")
            continue
        path = _relative_path(output.get("relative_path"))
        expected_prefix = f"batches/{manifest['cleaning_batch_id']}/dashboard_tables/"
        if not path.startswith(expected_prefix) or not path.endswith(".xlsx") or not _SHA256.fullmatch(str(output.get("sha256", ""))):
            _fail("cleaning_dashboard_manifest_invalid")
        if not _SHA256.fullmatch(str(output.get("business_content_sha256", ""))) or not isinstance(output.get("row_count"), int) or output["row_count"] < 0:
            _fail("cleaning_dashboard_manifest_invalid")
        if path in paths:
            _fail("cleaning_output_path_duplicate")
        paths.add(path)
    logical_input = manifest.get("logical_input")
    if logical_input is not None:
        validate_logical_cleaning_package_manifest_v2(logical_input)
        if logical_input["cleaning_package_id"] != manifest["cleaning_package_id"]:
            _fail("logical_cleaning_package_v2_invalid")
    return manifest


def validate_logical_cleaning_package_manifest_v2(manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(manifest, dict) or manifest.get("schema_version") != "logical_cleaning_package_manifest_v2" or "logical_cleaning_job_id" in manifest:
        _fail("logical_cleaning_package_v2_invalid")
    if not _UUID.fullmatch(str(manifest.get("cleaning_package_id", ""))) or not _UUID_V4.fullmatch(str(manifest.get("source_logical_export_job_id", ""))):
        _fail("logical_cleaning_package_v2_invalid")
    source = manifest.get("source_logical_job_manifest")
    if not isinstance(source, dict) or not _SHA256.fullmatch(str(source.get("sha256", ""))) or not isinstance(source.get("manifest_version"), int) or source["manifest_version"] < 1:
        _fail("logical_cleaning_package_source_invalid")
    _relative_path(source.get("relative_path"))
    if manifest.get("source_logical_job_status") not in {"success", "partial", "blocked", "failed"} or manifest.get("cleaning_package_status") not in {"success", "partial", "blocked", "failed"}:
        _fail("logical_cleaning_package_v2_invalid")
    list_fields = (
        "consumed_export_batch_ids", "consumed_authoritative_work_unit_attempt_ids",
        "unusable_authoritative_work_unit_attempt_ids", "excluded_non_authoritative_attempt_ids",
        "incomplete_required_work_units",
    )
    for field in list_fields:
        value = manifest.get(field)
        if not isinstance(value, list):
            _fail("logical_cleaning_package_v2_invalid")
    if len(manifest["consumed_export_batch_ids"]) != len(set(manifest["consumed_export_batch_ids"])) or any(not _UUID.fullmatch(str(item)) for item in manifest["consumed_export_batch_ids"]):
        _fail("logical_cleaning_package_batches_invalid")
    for field in ("consumed_authoritative_work_unit_attempt_ids", "unusable_authoritative_work_unit_attempt_ids", "excluded_non_authoritative_attempt_ids"):
        if len(manifest[field]) != len(set(manifest[field])) or any(not _UUID.fullmatch(str(item)) for item in manifest[field]):
            _fail("logical_cleaning_package_v2_invalid")
    return manifest
