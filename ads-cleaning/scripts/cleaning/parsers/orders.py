"""TikTok Shop order CSV parser."""
from __future__ import annotations
import csv
from pathlib import Path
from typing import Any
from record_key import record_key
from ..conversion import _convert, _required_string
from ..errors import CleaningError
from ..records import _base_row, _content_hash, _expected_headers, _source_row_key
from ..contracts import order_columns


def _validate_order_level_repeated_fields(
    rows: list[dict[str, Any]], operation_model: dict[str, Any], path: Path,
) -> dict[str, Any]:
    repeated_fields = [
        field for field in operation_model.get("fields", [])
        if field.get("aggregation") == "order_level_repeated"
    ]
    if not repeated_fields:
        return {"status": "not_applicable"}
    result: dict[str, Any] = {
        "status": "passed",
        "deduplication_key": repeated_fields[0].get("aggregation_key", []),
        "fields": {},
    }
    for field in repeated_fields:
        name = field["name"]
        key_fields = field.get("aggregation_key") or []
        if not key_fields:
            raise CleaningError("order_level_contract", f"missing aggregation key for {name}")
        grouped: dict[tuple[Any, ...], set[Any]] = {}
        for row in rows:
            key = tuple(row.get(key_name) for key_name in key_fields)
            value = row.get(name)
            if value is not None:
                grouped.setdefault(key, set()).add(value)
        conflicts = [key for key, values in grouped.items() if len(values) > 1]
        if conflicts:
            raise CleaningError(
                "order_level_amount_inconsistent",
                f"order-level field differs within deduplication key: {name} in {path}",
            )
        result["fields"][name] = {
            "aggregation_rule": field.get("aggregation_rule"),
            "groups_with_non_null_value": len(grouped),
        }
    return result


def _parse_order_file(manifest: dict[str, Any], report: dict[str, Any], file_meta: dict[str, Any], model: dict[str, Any], baseline: dict[str, Any], batch_id: str) -> list[tuple[str, list[dict[str, Any]], dict[str, Any]]]:
    path = Path(file_meta["path"])
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            physical_rows = list(csv.reader(handle))
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise CleaningError("order_csv_unreadable", f"cannot read order CSV: {path}") from exc
    if not physical_rows:
        raise CleaningError("source_empty_without_header", f"order CSV has no header: {path}")
    header = physical_rows[0]
    base_headers = _expected_headers("orders", baseline)
    tax_headers = _expected_headers("orders_local_tax_extension", baseline)
    if header not in [base_headers, base_headers + tax_headers]:
        raise CleaningError("header_mismatch", f"order CSV header differs from baseline: {path}")
    active_columns = order_columns(model, baseline)[:len(header)]
    if header != [item[0] for item in active_columns]:
        raise CleaningError("header_mismatch", f"order CSV header differs from model mapping: {path}")
    if report.get("currency_scope") != "shop_commerce":
        raise CleaningError("currency_scope_mismatch", "order report must use shop_commerce currency scope")
    currency = _required_string(report.get("currency"), "report.currency")
    datasets = {item["name"]: item for item in model["datasets"]}
    operation_model = datasets["order_line_operations"]
    fulfillment_model = datasets["order_fulfillment_detail"]
    operation_fields = {field["name"] for field in operation_model["fields"]}
    fulfillment_fields = {field["name"] for field in fulfillment_model["fields"]}
    operations: list[dict[str, Any]] = []
    fulfillment: list[dict[str, Any]] = []
    blank_rows = 0
    for row_number, values in enumerate(physical_rows[1:], start=2):
        if len(values) != len(header):
            raise CleaningError("row_width_mismatch", f"order row width differs from header: {path}:{row_number}")
        if all(not str(value).strip() for value in values):
            blank_rows += 1
            continue
        if any(str(value).startswith("=") for value in values):
            raise CleaningError("formula_cell", f"formula cell is not accepted: {path}:{row_number}")
        converted = {name: _convert(value, {"name": name, "type": field_type}) for value, (_, name, field_type) in zip(values, active_columns)}
        created_date = converted["created_at"][:10]
        if not manifest["request"]["start_date"] <= created_date <= manifest["request"]["end_date"]:
            raise CleaningError("order_created_date_mismatch", f"order Created Time differs from Manifest range: {path}:{row_number}")
        base = _base_row(manifest, "manage_orders_csv", file_meta, "CSV", row_number, batch_id)
        base["currency"] = currency
        for dataset, allowed, target in [(operation_model, operation_fields, operations), (fulfillment_model, fulfillment_fields, fulfillment)]:
            parsed = {**base, **{name: value for name, value in converted.items() if name in allowed}}
            parsed["record_key"] = record_key(dataset["name"], [parsed.get(name) for name in dataset["record_key_components"]])
            parsed["source_row_key"] = _source_row_key(file_meta["sha256"], "CSV", row_number)
            parsed["record_content_hash"] = _content_hash(dataset["name"], parsed, dataset["content_fields"])
            target.append(parsed)
    for dataset, rows in [(operation_model, operations), (fulfillment_model, fulfillment)]:
        keys = [row["record_key"] for row in rows]
        if len(keys) != len(set(keys)):
            raise CleaningError("record_key_duplicate", f"duplicate order record key in {dataset['name']}: {path}")
    order_level_aggregation = _validate_order_level_repeated_fields(operations, operation_model, path)
    qa_base = {
        "source_file": str(path), "source_rows_excluding_header": len(physical_rows) - 1,
        "detail_rows": len(operations), "summary_rows": 0, "blank_rows": blank_rows, "rejected_rows": 0,
        "row_conservation": len(physical_rows) - 1 == len(operations) + blank_rows,
        "summary_reconciliation": {"status": "not_applicable"}, "currency_scope": "shop_commerce", "currency": currency,
        "order_level_aggregation": order_level_aggregation,
    }
    return [
        (operation_model["name"], operations, {**qa_base, "logical_output": operation_model["name"]}),
        (fulfillment_model["name"], fulfillment, {**qa_base, "logical_output": fulfillment_model["name"]}),
    ]
