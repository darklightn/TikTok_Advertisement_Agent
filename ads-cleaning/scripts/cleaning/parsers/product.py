"""TikTok Shop product-performance parser."""
from __future__ import annotations
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from record_key import record_key
from xlsx_reader import XlsxReadError, read_first_sheet
from ..conversion import _convert, _money, _optional_string, _rate, _required_string
from ..errors import CleaningError
from ..records import _base_row, _canonical_row_hash, _content_hash, _dataset_for, _source_row_key
from ..contracts import COMMON_OUTPUT_FIELDS


def _parse_product_file(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], baseline: dict[str, Any], batch_id: str, product_columns: list[tuple[str, str]]) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    try:
        sheet_name, physical_rows = read_first_sheet(path)
    except XlsxReadError as exc:
        raise CleaningError(exc.code, f"{exc}: {path}") from exc
    if len(physical_rows) < 3:
        raise CleaningError("product_header_incomplete", f"product workbook lacks three header rows: {path}")
    date_row, group_row, metric_row = physical_rows[:3]
    contract = baseline.get("product_header") or {}
    if len(group_row) != contract.get("column_count") or len(metric_row) != contract.get("column_count"):
        raise CleaningError("header_mismatch", f"product header width differs from baseline: {path}")
    accepted_metric_hashes = set(contract.get("metric_row_sha256_accepted") or [contract.get("metric_row_sha256")])
    if _canonical_row_hash(group_row) != contract.get("group_row_sha256") or _canonical_row_hash(metric_row) not in accepted_metric_hashes:
        raise CleaningError("header_mismatch", f"product grouped header differs from baseline: {path}")
    date_text = str(date_row[0] if date_row else "").strip()
    match = re.fullmatch(r"数据分析日期: (\d{2}/\d{2}/\d{4})~(\d{2}/\d{2}/\d{4})", date_text)
    if not match:
        raise CleaningError("product_date_header_invalid", f"product date header is invalid: {path}")
    observed = [datetime.strptime(value, "%d/%m/%Y").date().isoformat() for value in match.groups()]
    requested = [manifest["request"]["start_date"], manifest["request"]["end_date"]]
    if observed != requested:
        raise CleaningError("product_date_header_mismatch", f"product date header differs from Manifest: {path}")
    dataset = _dataset_for(report_id, list(metric_row), model)
    rows: list[dict[str, Any]] = []
    blank_rows = 0
    for row_number, values in enumerate(physical_rows[3:], start=4):
        if len(values) > len(metric_row):
            raise CleaningError("row_width_mismatch", f"row has cells beyond the product header: {path}:{row_number}")
        values = values + (None,) * (len(metric_row) - len(values))
        if all(value is None or str(value).strip() == "" for value in values):
            blank_rows += 1
            continue
        parsed = _base_row(manifest, report_id, file_meta, sheet_name, row_number, batch_id)
        currencies: set[str] = set()
        for index, value in enumerate(values):
            name, kind = product_columns[index]
            if kind == "money":
                parsed[name], currency = _money(value, name)
                currencies.add(currency)
            elif kind == "rate":
                parsed[name] = _rate(value, name)
            else:
                parsed[name] = _convert(value, {"name": name, "type": kind})
        if len(currencies) != 1:
            raise CleaningError("currency_inconsistent", f"product row contains inconsistent currencies: {path}:{row_number}")
        parsed["currency"] = currencies.pop()
        key_values = [parsed.get(name) for name in dataset["record_key_components"]]
        parsed["record_key"] = record_key(dataset["name"], key_values)
        parsed["source_row_key"] = _source_row_key(file_meta["sha256"], sheet_name, row_number)
        content_fields = [name for name in parsed if name not in COMMON_OUTPUT_FIELDS and name not in {"record_key", "source_row_key", "record_content_hash"}]
        parsed["record_content_hash"] = _content_hash(dataset["name"], parsed, sorted(content_fields))
        rows.append(parsed)
    record_keys = [row["record_key"] for row in rows]
    if len(record_keys) != len(set(record_keys)):
        raise CleaningError("record_key_duplicate", f"duplicate product record key: {path}")
    qa = {
        "source_file": str(path), "source_rows_excluding_header": len(physical_rows) - 3,
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": blank_rows, "rejected_rows": 0,
        "row_conservation": len(physical_rows) - 3 == len(rows) + blank_rows,
        "summary_reconciliation": {"status": "not_applicable"},
        "product_header_rows": 3, "semantic_columns": len(product_columns),
        "_field_dictionary": [
            {"name": product_columns[index][0], "type": product_columns[index][1],
             "source": f"product_multiheader:index_{index + 1:03d}",
             "source_group": _optional_string(group_row[index]) or "identity",
             "source_header": _required_string(metric_row[index], f"product.metric_header.{index + 1}")}
            for index in range(len(product_columns))
        ],
    }
    return dataset["name"], rows, qa
