"""Parser for byte-preserved official shop promotion XLSX exports."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from record_key import record_key
from xlsx_reader import XlsxReadError, read_first_sheet

from ..contracts import _source_header
from ..conversion import _convert
from ..errors import CleaningError
from ..records import _base_row, _content_hash, _dataset_for, _source_row_key


DATE_BANNER = re.compile(
    r"^\[日期范围\]: (\d{4}-\d{2}-\d{2})T00:00:00 ~ (\d{4}-\d{2}-\d{2})T00:00:00\s*$"
)
TOOL_BANNER = re.compile(r"^\[促销工具\]:\s*(.*?)\s*$")
ACTIVITY_TIME = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) - (\d{4}-\d{2}-\d{2} \d{2}:\d{2})$"
)


def _local_datetime(value: str, field: str) -> str:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d %H:%M")
    except ValueError as exc:
        raise CleaningError("invalid_promotion_datetime", f"invalid {field}: {value!r}") from exc
    return parsed.isoformat(timespec="milliseconds")


def _parse_promotion_file(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any],
    model: dict[str, Any], baseline: dict[str, Any], batch_id: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    try:
        sheet_name, physical_rows = read_first_sheet(path)
    except XlsxReadError as exc:
        raise CleaningError(exc.code, f"{exc}: {path}") from exc
    if len(physical_rows) < 3:
        raise CleaningError("source_empty_without_header", f"promotion workbook lacks banners or header: {path}")

    date_text = "" if not physical_rows[0] else str(physical_rows[0][0])
    date_match = DATE_BANNER.fullmatch(date_text)
    if date_match is None:
        raise CleaningError("promotion_date_banner_invalid", f"promotion date banner differs from contract: {path}")
    requested_start = date.fromisoformat(manifest["request"]["start_date"])
    requested_end_exclusive = date.fromisoformat(manifest["request"]["end_date"]) + timedelta(days=1)
    if date.fromisoformat(date_match.group(1)) != requested_start or date.fromisoformat(date_match.group(2)) != requested_end_exclusive:
        raise CleaningError("promotion_date_banner_mismatch", f"promotion date banner differs from requested range: {path}")

    tool_text = "" if not physical_rows[1] else str(physical_rows[1][0])
    tool_match = TOOL_BANNER.fullmatch(tool_text)
    if tool_match is None:
        raise CleaningError("promotion_tool_banner_invalid", f"promotion tool banner differs from contract: {path}")

    header = ["" if value is None else str(value) for value in physical_rows[2]]
    expected = baseline["families"]["promotion"]
    if header != expected:
        raise CleaningError("header_mismatch", f"promotion header differs from baseline: {path}")
    dataset = _dataset_for(report_id, header, model)
    field_by_header = {_source_header(field): field for field in dataset["fields"] if _source_header(field)}

    rows: list[dict[str, Any]] = []
    blank_rows = 0
    for row_number, values in enumerate(physical_rows[3:], start=4):
        if len(values) > len(header):
            raise CleaningError("row_width_mismatch", f"row has cells beyond promotion header: {path}:{row_number}")
        values = values + (None,) * (len(header) - len(values))
        if all(value is None or not str(value).strip() for value in values):
            blank_rows += 1
            continue
        if any(isinstance(value, str) and value.startswith("=") for value in values):
            raise CleaningError("formula_cell", f"formula cell is not accepted: {path}:{row_number}")
        parsed = _base_row(manifest, report_id, file_meta, sheet_name, row_number, batch_id)
        parsed["currency"] = "PHP"
        for column, value in zip(header, values):
            if column == "活动时间":
                match = ACTIVITY_TIME.fullmatch("" if value is None else str(value).strip())
                if match is None:
                    raise CleaningError("invalid_promotion_datetime", f"invalid activity time: {path}:{row_number}")
                parsed["promotion_start_datetime_local"] = _local_datetime(match.group(1), "promotion start")
                parsed["promotion_end_datetime_local"] = _local_datetime(match.group(2), "promotion end")
                continue
            field = field_by_header[column]
            parsed[field["name"]] = _convert(value, field)
        parsed["source_row_key"] = _source_row_key(file_meta["sha256"], sheet_name, row_number)
        parsed["record_key"] = record_key(dataset["name"], [parsed.get(name) for name in dataset["record_key_components"]])
        parsed["record_content_hash"] = _content_hash(dataset["name"], parsed, dataset["content_fields"])
        rows.append(parsed)

    qa = {
        "source_file": str(path), "source_rows_excluding_header": len(physical_rows) - 1,
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": blank_rows, "rejected_rows": 0,
        "banner_rows": 2,
        "row_conservation": len(physical_rows) == len(rows) + blank_rows + 3,
        "summary_reconciliation": {"status": "not_applicable"},
        "date_banner_start": date_match.group(1), "date_banner_end_exclusive": date_match.group(2),
        "promotion_tool_filter": tool_match.group(1) or None,
    }
    return dataset["name"], rows, qa
