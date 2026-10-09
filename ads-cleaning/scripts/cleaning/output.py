"""Deterministic table and field-dictionary output helpers."""
from __future__ import annotations
import csv
import hashlib
import json
import os
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from .contracts import applicable_common_output_fields
from .conversion import _seller_time_context
from .dashboards import DASHBOARD_CONTRACT_VERSION, DashboardBuildError, build_dashboard_workbooks
from .errors import CleaningError
from .files import _json_bytes, _sha256
from .records import CLEANING_VERSION
from .storage_contracts import validate_cleaning_batch_manifest_v3

FIELD_DICTIONARY_SCHEMA_VERSION = "cleaning_field_dictionary_v3"
_FIELD_REQUIRED = ("name", "type", "source")
_FIELD_MODEL_OPTIONAL = ("aggregation", "semantics", "aggregation_key", "aggregation_rule", "semantic_note")
_FIELD_DERIVED_OPTIONAL = ("formula", "numerator_fields", "denominator_fields", "zero_denominator_behavior")
_FIELD_DYNAMIC_OPTIONAL = ("source_group", "source_header")
_FIELD_MODEL_INPUT_IGNORED = ("applies_to",)
def _write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, Any]], dataset_name: str) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n", extrasaction="raise")
        writer.writeheader()
        sort_key = (lambda item: (item["campaign_id"], item["metric_hour"], item["record_key"])) \
            if dataset_name == "gmvmax_campaign_hourly_performance" else (lambda item: item["record_key"])
        for row in sorted(rows, key=sort_key):
            writer.writerow({name: "" if row.get(name) is None else row.get(name) for name in fieldnames})


def _derived_fields(model: dict[str, Any], dataset_name: str) -> list[dict[str, Any]]:
    return [field for field in model.get("derived_metric_fields", []) if dataset_name in field.get("applies_to", [])]


def _field_dictionary_entry(
    field: dict[str, Any], dataset_name: str, *, dynamic: bool = False, derived: bool = False,
) -> dict[str, Any]:
    missing = [name for name in _FIELD_REQUIRED if not field.get(name)]
    if missing:
        raise CleaningError("field_dictionary_contract", f"{dataset_name} field missing: {','.join(missing)}")
    allowed = _FIELD_REQUIRED + _FIELD_MODEL_OPTIONAL
    if derived:
        allowed += _FIELD_DERIVED_OPTIONAL
    if dynamic:
        allowed += _FIELD_DYNAMIC_OPTIONAL
    unknown = sorted(set(field) - set(allowed) - set(_FIELD_MODEL_INPUT_IGNORED))
    if unknown:
        raise CleaningError("field_dictionary_contract", f"{dataset_name}.{field['name']} has unknown metadata: {','.join(unknown)}")
    if dynamic and any(not field.get(name) for name in _FIELD_DYNAMIC_OPTIONAL):
        raise CleaningError("field_dictionary_contract", f"{dataset_name}.{field['name']} lacks dynamic source metadata")
    entry = {name: field[name] for name in allowed if name in field}
    name = field["name"]
    field_type = field["type"]
    entry.update({
        "aggregation": field.get("aggregation", "not_applicable"),
        "formula": field.get("formula"),
        "zero_denominator_behavior": field.get("zero_denominator_behavior"),
        "currency_behavior": field.get("currency_behavior", _currency_behavior(name, field_type)),
        "semantic_role": field.get("semantic_role", _semantic_role(name, field)),
        "time_role": field.get("time_role", _time_role(name, field_type)),
        "nullable": field_type.endswith("_nullable"),
    })
    return entry


def _currency_behavior(name: str, field_type: str) -> str:
    if name == "currency":
        return "row_currency_code"
    if name == "currency_scope":
        return "currency_scope_descriptor"
    ratios = {"rate", "ratio", "roi", "roas", "percent", "percentage"}
    monetary = {"cost", "budget", "revenue", "value", "price", "amount", "fee", "refund", "sales", "gmv", "income", "commission", "tax", "discount"}
    is_money = field_type.startswith("decimal") and any(token in name for token in monetary) and not any(token in name for token in ratios)
    return "value_in_row_currency" if is_money else "not_applicable"


def _semantic_role(name: str, field: dict[str, Any]) -> str:
    source = str(field.get("source") or "")
    aggregation = field.get("aggregation")
    if name.endswith("_id") or name in {"record_key", "source_row_key", "record_content_hash"}:
        return "identifier"
    if name in {"currency", "currency_scope"}:
        return "currency"
    if name.endswith("_json") or name.startswith("raw_"):
        return "raw_payload"
    if name.endswith("_date") or name.endswith("_at_utc") or "time" in name:
        return "time"
    if source.startswith("derived:"):
        return "derived_measure"
    if aggregation == "sum":
        return "additive_measure"
    if aggregation in {"non_additive", "recompute_from_additive_inputs"}:
        return "non_additive_measure"
    if "status" in name or name.endswith("_raw"):
        return "status_or_enum"
    if name.startswith("source_") or name.startswith("cleaning_") or name.startswith("export_") or name.startswith("logical_") or name.startswith("work_unit") or name.startswith("authoritative_"):
        return "lineage"
    return "dimension"


def _time_role(name: str, field_type: str) -> str:
    if name in {"requested_start_date", "requested_end_date"}:
        return "request_boundary"
    if name in {"metric_date", "metric_hour"}:
        return "metric_time"
    if name == "captured_at_utc":
        return "capture_time"
    if "datetime" in field_type or field_type == "date" or "time" in name:
        return "source_event_or_schedule_time"
    return "not_applicable"


def _field_dictionary_fields(
    model: dict[str, Any], dataset_name: str, field_dictionary_overrides: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    datasets = {item["name"]: item for item in model.get("datasets", [])}
    dataset = datasets.get(dataset_name)
    if dataset is None:
        raise CleaningError("field_dictionary_contract", f"unknown dataset: {dataset_name}")
    common_names = set(applicable_common_output_fields(model, dataset_name))
    common = [field for field in model.get("common_fields", []) if field["name"] in common_names]
    override = field_dictionary_overrides.get(dataset_name, [])
    if override:
        dynamic_names = {field["name"] for field in override}
        modeled = [field for field in dataset.get("fields", []) if field["name"] not in dynamic_names]
        fields = [
            _field_dictionary_entry(field, dataset_name)
            for field in common + modeled
        ] + [
            _field_dictionary_entry(field, dataset_name, dynamic=True)
            for field in override
        ]
    else:
        modeled = list(dataset.get("fields", []))
        derived = _derived_fields(model, dataset_name)
        fields = [
            _field_dictionary_entry(field, dataset_name)
            for field in common + modeled
        ] + [
            _field_dictionary_entry(field, dataset_name, derived=True)
            for field in derived
        ]
    names = [field["name"] for field in fields]
    if len(names) != len(set(names)):
        raise CleaningError("field_dictionary_contract", f"duplicate field name in {dataset_name}")
    return fields


def _build_field_dictionary(
    model: dict[str, Any], collected: dict[str, list[dict[str, Any]]],
    field_dictionary_overrides: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    model_version = model.get("model_version")
    if not model_version:
        raise CleaningError("field_dictionary_contract", "model_version is required")
    datasets = {}
    for dataset_name in sorted(collected):
        fields = _field_dictionary_fields(model, dataset_name, field_dictionary_overrides)
        datasets[dataset_name] = {
            "grain": next(item["grain"] for item in model["datasets"] if item["name"] == dataset_name),
            "fields": fields,
        }
    return {
        "schema_version": FIELD_DICTIONARY_SCHEMA_VERSION,
        "model_version": model_version,
        "datasets": datasets,
    }


def detect_field_dictionary_schema(dictionary: Any) -> str:
    if not isinstance(dictionary, dict):
        raise CleaningError("field_dictionary_schema_unsupported", "field dictionary must be an object")
    if dictionary.get("schema_version") == FIELD_DICTIONARY_SCHEMA_VERSION:
        if not isinstance(dictionary.get("datasets"), dict):
            raise CleaningError("field_dictionary_schema_unsupported", "v3 field dictionary datasets must be an object")
        return "v3"
    raise CleaningError("field_dictionary_schema_unsupported", "only cleaning_field_dictionary_v3 is supported")

def _materialize_batch(
    report_ids: list[str], output_root: Path, model: dict[str, Any],
    manifest: dict[str, Any], batch_id: str,
    selected: list[tuple[str, dict[str, Any], dict[str, Any]]],
    collected: dict[str, list[dict[str, Any]]], file_qa: list[dict[str, Any]],
    field_dictionary_overrides: dict[str, list[dict[str, Any]]], all_record_keys: list[str],
    *, package_context: dict[str, Any] | None = None,
    dataset_source_artifacts: dict[str, set[str]] | None = None,
    successful_report_ids: list[str] | None = None, failed_reports: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    successful_report_ids = sorted(successful_report_ids if successful_report_ids is not None else report_ids)
    failed_reports = failed_reports or []
    if (package_context or {}).get("schema_version") != "cleaning_batch_manifest_v3":
        raise CleaningError("cleaning_manifest_schema_unsupported", "only cleaning_batch_manifest_v3 output is supported")
    return _materialize_batch_v3(
        report_ids, output_root, model, manifest, batch_id, selected, collected, file_qa,
        field_dictionary_overrides, all_record_keys, package_context or {},
        dataset_source_artifacts or {}, successful_report_ids, failed_reports,
    )


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _runtime_binding(output_root: Path, directory: str, version: str, content_hash: str) -> dict[str, Any]:
    pointer_path = output_root / "_system" / directory / "current.json"
    if not pointer_path.is_file():
        raise CleaningError("cleaning_runtime_not_initialized", f"runtime pointer is missing: {pointer_path}")
    try:
        pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleaningError("cleaning_runtime_invalid", f"runtime pointer is invalid: {pointer_path}") from exc
    relative = pointer.get("relative_path")
    if pointer.get("version") != version or pointer.get("content_sha256") != content_hash or not isinstance(relative, str):
        raise CleaningError("cleaning_runtime_version_mismatch", f"runtime pointer differs from requested model: {pointer_path}")
    target = output_root.joinpath(*relative.split("/"))
    if not target.is_file() or _sha256(target) != pointer.get("file_sha256"):
        raise CleaningError("cleaning_runtime_hash_mismatch", f"runtime snapshot hash differs: {target}")
    return {
        "schema_version": "dataset_catalog_binding_v1",
        "catalog_version": version,
        "relative_path": relative,
        "content_sha256": content_hash,
        "file_sha256": pointer["file_sha256"],
    }


def _storage_binding(output_root: Path) -> dict[str, Any]:
    relative = "_system/contracts/cleaning-storage-contract-v2.json"
    path = output_root.joinpath(*relative.split("/"))
    if not path.is_file():
        raise CleaningError("cleaning_runtime_not_initialized", f"storage contract snapshot is missing: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleaningError("cleaning_runtime_invalid", f"storage contract snapshot is invalid: {path}") from exc
    if value.get("contract_id") != "cleaning_storage_contract" or value.get("contract_version") != "2.0.0":
        raise CleaningError("cleaning_storage_contract_mismatch", "runtime storage contract differs")
    return {"contract_id": "cleaning_storage_contract", "contract_version": "2.0.0", "relative_path": relative, "sha256": _sha256(path)}


def _materialize_batch_v3(
    report_ids: list[str], output_root: Path, model: dict[str, Any], source_manifest: dict[str, Any],
    batch_id: str, selected: list[tuple[str, dict[str, Any], dict[str, Any]]],
    collected: dict[str, list[dict[str, Any]]], file_qa: list[dict[str, Any]],
    field_dictionary_overrides: dict[str, list[dict[str, Any]]], all_record_keys: list[str],
    package_context: dict[str, Any], dataset_source_artifacts: dict[str, set[str]],
    successful_report_ids: list[str], failed_reports: list[dict[str, Any]],
) -> dict[str, Any]:
    output_root.mkdir(parents=True, exist_ok=True)
    staging_root = output_root / "_staging"
    final_root = output_root / "batches"
    staging_root.mkdir(parents=True, exist_ok=True)
    final_root.mkdir(parents=True, exist_ok=True)
    staging = staging_root / batch_id
    final_dir = final_root / batch_id
    if staging.exists():
        raise CleaningError("cleaning_staging_conflict", f"cleaning staging directory already exists: {staging}")
    staging.mkdir()
    try:
        tables = staging / "tables"
        tables.mkdir()
        datasets = {item["name"]: item for item in model["datasets"]}
        output_entries: list[dict[str, Any]] = []
        for dataset_name, rows in sorted(collected.items()):
            common_names = applicable_common_output_fields(model, dataset_name)
            modeled = [field["name"] for field in datasets[dataset_name]["fields"] + _derived_fields(model, dataset_name)]
            extras = [field["name"] for field in field_dictionary_overrides.get(dataset_name, []) if field["name"] not in modeled]
            table = tables / f"{dataset_name}.csv"
            _write_csv(table, common_names + modeled + extras, rows, dataset_name)
            source_ids = sorted(dataset_source_artifacts.get(dataset_name) or [])
            if not source_ids:
                raise CleaningError("cleaning_source_artifact_binding_missing", f"dataset lacks source Artifact binding: {dataset_name}")
            output_entries.append({
                "output_id": dataset_name,
                "dataset_name": dataset_name,
                "relative_path": f"batches/{batch_id}/tables/{dataset_name}.csv",
                "sha256": _sha256(table),
                "row_count": len(rows),
                "source_artifact_ids": source_ids,
            })
        dictionary = _build_field_dictionary(model, collected, field_dictionary_overrides)
        dictionary_path = staging / "field_dictionary.json"
        dictionary_path.write_bytes(_json_bytes(dictionary))
        qa_files = []
        path_to_lineage = {str(Path(meta["path"]).resolve()): meta.get("lineage_path", meta["path"]) for _rid, _report, meta in selected}
        for item in file_qa:
            copy = dict(item)
            source = copy.get("source_file")
            if source is not None:
                copy["source_file"] = path_to_lineage.get(str(Path(source).resolve()), source)
            qa_files.append(copy)
        effective_status = "partial" if failed_reports else package_context.get("cleaning_package_status", "success")
        quality = {
            "schema_version": "cleaning_quality_report_v1",
            "cleaning_batch_id": batch_id,
            "status": "passed",
            "cleaning_package_status": effective_status,
            "qa_scope": "published_outputs_only",
            "runtime_gates": {"input_qualification": "passed", "schema_and_parsing": "passed", "identity_and_conservation": "passed", "semantic_reconciliation": "passed"},
            "files": qa_files,
            "totals": {"source_files": len(selected), "fact_rows": len(all_record_keys), "datasets": dict(sorted(Counter({name: len(rows) for name, rows in collected.items()}).items()))},
        }
        quality_path = staging / "quality_report.json"
        quality_path.write_bytes(_json_bytes(quality))

        source_context = package_context.get("source_context") or {}
        authoritative_units = source_context.get("authoritative_work_units") or []
        statuses_by_report: dict[str, list[str]] = {}
        for unit in authoritative_units:
            statuses_by_report.setdefault(unit["report_id"], []).append(unit["execution_status"])
        official_no_data_reports = {
            report_id for report_id, statuses in statuses_by_report.items()
            if statuses and all(status == "no_data" for status in statuses)
        }
        official_no_data_sources = {
            dataset["name"] for dataset in model["datasets"]
            if dataset.get("report_id") in official_no_data_reports
        }
        try:
            dashboard_outputs = build_dashboard_workbooks(
                staging,
                collected,
                Path(__file__).resolve().parents[2] / "config" / "dashboard-contract-v1.json",
                official_no_data_sources,
            )
            for dashboard_output in dashboard_outputs:
                if dashboard_output.get("relative_path"):
                    dashboard_output["relative_path"] = f"batches/{batch_id}/{dashboard_output['relative_path']}"
        except DashboardBuildError as exc:
            raise CleaningError("dashboard_generation_failed", str(exc)) from exc
        applicable_dashboards = [item for item in dashboard_outputs if not (item.get("explicit_only") and "gmvmax_campaign_hourly_performance" not in collected)]
        dashboard_status = "complete" if all(item.get("status") in {"generated", "official_zero"} for item in applicable_dashboards) else "partial"

        source_manifests = source_context.get("source_manifests") or ([source_context["source_manifest"]] if source_context.get("source_manifest") else [])
        source_artifacts = sorted({item["artifact_id"]: item for item in source_context.get("source_artifacts") or []}.values(), key=lambda item: item["artifact_id"])
        authoritative_units = sorted(authoritative_units, key=lambda item: item["work_unit_id"])
        model_hash = hashlib.sha256(_canonical(model)).hexdigest()
        try:
            from stage4_catalogs import build_dataset_catalog
        except ModuleNotFoundError:
            from scripts.stage4_catalogs import build_dataset_catalog
        catalog = build_dataset_catalog(model)
        catalog_binding = _runtime_binding(output_root, "dataset-catalogs", catalog["catalog_version"], catalog["catalog_sha256"])
        logical_input = package_context.get("logical_input")
        if logical_input is not None:
            logical_input = dict(logical_input)
            logical_input["cleaning_package_id"] = batch_id
        created_at = package_context.get("created_at_utc")
        _seller_time_context(source_manifest["shop"])
        manifest = {
            "schema_version": "cleaning_batch_manifest_v3",
            "cleaning_batch_id": batch_id,
            "cleaning_package_id": batch_id,
            "created_at_utc": created_at,
            "published_at_utc": created_at,
            "storage_contract": _storage_binding(output_root),
            "model": {"schema_version": model["schema_version"], "model_version": model["model_version"], "sha256": model_hash, "sha256_scope": "UTF8_JSON_sorted_keys_compact"},
            "dataset_catalog": catalog_binding,
            "dataset_names": sorted(collected),
            "cleaning_version": CLEANING_VERSION,
            "cleaning_package_status": effective_status,
            "cleaning_batch_status": effective_status,
            "source_logical_job_status": logical_input.get("source_logical_job_status") if logical_input is not None else None,
            "qa_status": "passed",
            "qa_scope": "published_outputs_only",
            "report_ids": sorted(report_ids),
            "successful_report_ids": successful_report_ids,
            "failed_reports": failed_reports,
            "shop": {
                "shop_id": source_manifest["shop"]["seller_id"],
                **{field: source_manifest["shop"].get(field) for field in (
                    "provider_id", "shop_alias", "shop_region", "business_timezone",
                    "business_timezone_source", "business_timezone_observed_at",
                ) if source_manifest["shop"].get(field) is not None},
            },
            "selected_advertiser": source_manifest.get("selected_advertiser"),
            "request": source_manifest["request"],
            "source_manifests": sorted(source_manifests, key=lambda item: item["export_batch_id"]),
            "source_artifacts": source_artifacts,
            "authoritative_work_units": authoritative_units,
            "outputs": output_entries,
            "dashboard_status": dashboard_status,
            "dashboard_contract_version": DASHBOARD_CONTRACT_VERSION,
            "dashboard_outputs": dashboard_outputs,
            "supporting_files": [
                {"relative_path": f"batches/{batch_id}/field_dictionary.json", "sha256": _sha256(dictionary_path)},
                {"relative_path": f"batches/{batch_id}/quality_report.json", "sha256": _sha256(quality_path)},
            ],
        }
        if logical_input is not None:
            manifest["logical_input"] = logical_input
        validate_cleaning_batch_manifest_v3(manifest)
        manifest_path = staging / "cleaning_manifest.json"
        manifest_path.write_bytes(_json_bytes(manifest))
        if final_dir.exists():
            generated = {path.relative_to(staging): _sha256(path) for path in staging.rglob("*") if path.is_file()}
            existing = {path.relative_to(final_dir): _sha256(path) for path in final_dir.rglob("*") if path.is_file()}
            if generated != existing:
                differing = sorted(str(path) for path in set(generated) | set(existing) if generated.get(path) != existing.get(path))
                raise CleaningError("immutable_output_conflict", f"existing v3 cleaning batch differs: {', '.join(differing)}")
            shutil.rmtree(staging)
            status = "reused"
        else:
            os.replace(staging, final_dir)
            status = "created"
        missing_dashboards = [
            {"audience": item.get("audience"), "table_name": item.get("table_name"), "missing_sources": item.get("missing_sources", [])}
            for item in applicable_dashboards if item.get("status") == "source_missing"
        ]
        return {"status": status, "cleaning_batch_id": batch_id, "cleaning_package_status": effective_status, "successful_report_ids": successful_report_ids, "failed_reports": failed_reports, "dashboard_status": dashboard_status, "dashboard_generated": sum(item.get("status") in {"generated", "official_zero"} for item in dashboard_outputs), "dashboard_missing": len(missing_dashboards), "dashboard_missing_tables": missing_dashboards, "output_dir": str(final_dir), "datasets": {name: len(rows) for name, rows in sorted(collected.items())}}
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise
