"""Parser for generated shop-health snapshots from official structured responses."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from record_key import record_key
from xlsx_reader import XlsxReadError, read_first_sheet

from ..conversion import _date_value, _decimal, _integer, _optional_string, _required_string, _utc_datetime_value
from ..errors import CleaningError
from ..records import _base_row, _content_hash, _dataset_for, _source_row_key


VALUE = re.compile(r"^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%)?$")
TARGET = re.compile(r"^(>=|<=|>|<)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%)?$")


def _metric_value(value: Any, field: str) -> tuple[str | None, str | None, str | None]:
    raw = _optional_string(value)
    if raw is None:
        return None, None, None
    match = VALUE.fullmatch(raw)
    if match is None:
        raise CleaningError("shop_health_value_invalid", f"invalid {field}: {value!r}")
    return raw, _decimal(match.group(1), field), "%" if match.group(2) else None


def _target_value(value: Any) -> tuple[str | None, str | None, str | None, str | None]:
    raw = _optional_string(value)
    if raw is None:
        return None, None, None, None
    match = TARGET.fullmatch(raw)
    if match is None:
        raise CleaningError("shop_health_target_invalid", f"invalid target condition: {value!r}")
    return raw, match.group(1), _decimal(match.group(2), "target_value_numeric"), "%" if match.group(3) else None


def _parse_health_file(
    manifest: dict[str, Any], report_id: str, report: dict[str, Any], file_meta: dict[str, Any],
    model: dict[str, Any], baseline: dict[str, Any], batch_id: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    try:
        sheet_name, physical_rows = read_first_sheet(path)
    except XlsxReadError as exc:
        raise CleaningError(exc.code, f"{exc}: {path}") from exc
    if not physical_rows:
        raise CleaningError("source_empty_without_header", f"shop health workbook has no header: {path}")
    header = ["" if value is None else str(value) for value in physical_rows[0]]
    if header != baseline["families"]["health"]:
        raise CleaningError("header_mismatch", f"shop health header differs from baseline: {path}")
    dataset = _dataset_for(report_id, header, model)
    manifest_captured_at = _utc_datetime_value(report["captured_at"], "report.captured_at")
    rows: list[dict[str, Any]] = []
    for row_number, values in enumerate(physical_rows[1:], start=2):
        if len(values) != len(header):
            raise CleaningError("row_width_mismatch", f"shop health row width differs: {path}:{row_number}")
        if all(value is None or not str(value).strip() for value in values):
            raise CleaningError("unexpected_blank_row", f"shop health contains a blank row: {path}:{row_number}")
        if any(isinstance(value, str) and value.startswith("=") for value in values):
            raise CleaningError("formula_cell", f"formula cell is not accepted: {path}:{row_number}")
        captured_at = _utc_datetime_value(values[0], "captured_at")
        if captured_at != manifest_captured_at:
            raise CleaningError("captured_at_mismatch", f"row capture time differs from Manifest: {path}:{row_number}")
        parsed = _base_row(manifest, report_id, file_meta, sheet_name, row_number, batch_id)
        parsed["captured_at"] = captured_at
        parsed["category"] = _required_string(values[1], "category")
        parsed["metric_name"] = _required_string(values[2], "metric_name")
        parsed["current_value_raw"], parsed["current_value_numeric"], parsed["current_value_unit"] = _metric_value(values[3], "current_value")
        parsed["target_condition_raw"], parsed["target_operator"], parsed["target_value_numeric"], parsed["target_value_unit"] = _target_value(values[4])
        parsed["assessment_start"] = _date_value(values[5], "assessment_start", nullable=True)
        parsed["assessment_end"] = _date_value(values[6], "assessment_end", nullable=True)
        parsed["violation_count"] = None if _optional_string(values[7]) is None else _integer(values[7], "violation_count")
        parsed["explanation"] = _optional_string(values[8])
        parsed["source_row_key"] = _source_row_key(file_meta["sha256"], sheet_name, row_number)
        parsed["record_key"] = record_key(dataset["name"], [parsed.get(name) for name in dataset["record_key_components"]])
        parsed["record_content_hash"] = _content_hash(dataset["name"], parsed, dataset["content_fields"])
        rows.append(parsed)

    identities = [(row["category"], row["metric_name"]) for row in rows]
    required = [("账号健康", "账号健康分"), ("违规概览", "违规分")]
    if identities[:2] != required or len(identities) != len(set(identities)) or len(rows) < 3:
        raise CleaningError("shop_health_metric_set_invalid", f"shop health identity set differs from contract: {path}")
    qa = {
        "source_file": str(path), "source_rows_excluding_header": len(physical_rows) - 1,
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": len(rows) == len(physical_rows) - 1,
        "summary_reconciliation": {"status": "not_applicable"},
        "captured_at": manifest_captured_at,
        "metric_identities": [{"category": category, "metric_name": metric} for category, metric in identities],
        "nullable_current_value_rows": sum(row["current_value_raw"] is None for row in rows),
    }
    return dataset["name"], rows, qa
