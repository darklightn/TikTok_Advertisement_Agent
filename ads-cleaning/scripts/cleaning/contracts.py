"""Load and validate machine-readable report field contracts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .errors import CleaningError
from .files import _read_json

COMMON_OUTPUT_FIELDS = [
    "record_key", "source_row_key", "record_content_hash", "report_id", "provider_id",
    "shop_alias", "shop_id", "shop_region", "business_timezone", "advertiser_id", "advertiser_name", "requested_start_date",
    "requested_end_date", "export_batch_id", "logical_export_job_id", "work_unit_id", "coverage_unit_key",
    "authoritative_attempt_id", "batch_status", "logical_job_status", "report_campaign_universe_policy",
    "universe_completeness_status", "cleaning_batch_id", "cleaning_version",
    "source_file_path", "source_file_hash", "source_sheet", "source_row_number", "currency", "currency_scope",
]


def cleanable_report_ids(model: dict[str, Any]) -> set[str]:
    """Return canonical report IDs enabled by the cleaning model."""
    datasets = model.get("datasets")
    if not isinstance(datasets, list):
        raise CleaningError("cleaning_model_invalid", "cleaning model datasets must be a list")
    report_ids = {
        item.get("report_id")
        for item in datasets
        if isinstance(item, dict) and item.get("capability_status") == "model_ready"
    }
    if not report_ids or any(not isinstance(report_id, str) or not report_id for report_id in report_ids):
        raise CleaningError("cleaning_model_invalid", "model-ready datasets must declare canonical report IDs")
    return report_ids


def applicable_common_output_fields(model: dict[str, Any], dataset_name: str) -> list[str]:
    """Return the ordered common fields applicable to one logical dataset."""
    datasets = {item["name"]: item for item in model.get("datasets", [])}
    dataset = datasets.get(dataset_name)
    if dataset is None:
        raise CleaningError("unknown_dataset", f"unknown dataset: {dataset_name}")
    policy = dataset.get("common_field_policy")
    if policy is None:
        return [field["name"] for field in model.get("common_fields", [])]
    included = policy.get("include")
    if not isinstance(included, list) or len(included) != len(set(included)):
        raise CleaningError("common_field_contract", f"invalid common field include list: {dataset_name}")
    common_names = [field["name"] for field in model.get("common_fields", [])]
    if included != [name for name in common_names if name in included]:
        raise CleaningError("common_field_contract", f"common field order differs from model: {dataset_name}")
    unknown = sorted(set(included) - set(common_names))
    if unknown:
        raise CleaningError("common_field_contract", f"unknown common fields in {dataset_name}: {','.join(unknown)}")
    required = policy.get("required", [])
    if not isinstance(required, list) or not set(required).issubset(set(included)):
        raise CleaningError("common_field_contract", f"required common fields are not applicable: {dataset_name}")
    return included


def _source_header(field: dict[str, Any]) -> str | None:
    source = field.get("source", "")
    return source.split(":", 1)[1] if source.startswith("source_column:") else None


def order_columns(model: dict[str, Any], baseline: dict[str, Any]) -> list[tuple[str, str, str]]:
    datasets = {item["name"]: item for item in model["datasets"]}
    fields = datasets["order_line_operations"]["fields"] + datasets["order_fulfillment_detail"]["fields"]
    semantics: dict[str, tuple[str, str]] = {}
    for field in fields:
        header = _source_header(field)
        if header is None:
            continue
        value = (field["name"], field["type"])
        if header in semantics and semantics[header] != value:
            raise CleaningError("order_contract_conflict", f"order field differs between datasets: {header}")
        semantics[header] = value
    headers = baseline["families"]["orders"] + baseline["families"]["orders_local_tax_extension"]
    missing = [header for header in headers if header not in semantics]
    extra = sorted(set(semantics) - set(headers))
    if missing or extra:
        raise CleaningError("order_contract_mismatch", f"order mapping differs from source baseline: missing={missing}, extra={extra}")
    return [(header, *semantics[header]) for header in headers]


def product_columns(model: dict[str, Any], model_path: Path) -> list[tuple[str, str]]:
    datasets = [item for item in model["datasets"] if item["name"] in {"product_performance_interval", "shop_product_performance_daily"}]
    if {item["name"] for item in datasets} != {"product_performance_interval", "shop_product_performance_daily"}:
        raise CleaningError("product_contract_invalid", "interval and daily product datasets must both be modeled")
    contracts: list[list[tuple[str, str]]] = []
    for dataset in datasets:
        dynamic = dataset["dynamic_field_contract"]
        contract_path = model_path.parent / dynamic["contract_file"]
        contract = _read_json(contract_path)
        if contract.get("schema_version") != "product_performance_contract_v1" or contract.get("report_id") != dataset["report_id"] or contract.get("dataset") != dataset["name"]:
            raise CleaningError("product_contract_invalid", f"unexpected product contract identity: {contract_path}")
        fields = contract.get("fields")
        if not isinstance(fields, list) or len(fields) != dynamic["column_count"]:
            raise CleaningError("product_contract_invalid", f"product contract width differs from model: {contract_path}")
        allowed_types = {"string", "id_string", "integer", "money", "rate"}
        columns = []
        for expected_index, field in enumerate(fields, start=1):
            if field.get("column_index") != expected_index or not field.get("name") or field.get("type") not in allowed_types:
                raise CleaningError("product_contract_invalid", f"invalid product contract field at column {expected_index}")
            columns.append((field["name"], field["type"]))
        if len({name for name, _ in columns}) != len(columns):
            raise CleaningError("product_contract_invalid", "product contract field names must be unique")
        contracts.append(columns)
    if contracts[0] != contracts[1]:
        raise CleaningError("product_contract_conflict", "daily and interval product source columns differ")
    return contracts[0]
