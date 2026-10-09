"""Parser for byte-preserved official product-ratings CSV exports."""
from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path
from typing import Any

from record_key import record_key
from ..conversion import _convert
from ..errors import CleaningError
from ..records import _base_row, _content_hash, _dataset_for, _source_row_key


def _parse_ratings_file(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any],
    model: dict[str, Any], baseline: dict[str, Any], batch_id: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            physical_rows = list(csv.reader(handle))
    except (OSError, UnicodeError, csv.Error) as exc:
        raise CleaningError("source_csv_unreadable", f"cannot read ratings CSV: {path}") from exc
    if not physical_rows:
        raise CleaningError("source_empty_without_header", f"ratings CSV has no header: {path}")
    header = physical_rows[0]
    expected = baseline["families"]["ratings"]
    if header != expected:
        raise CleaningError("header_mismatch", f"ratings header differs from baseline: {path}")
    dataset = _dataset_for(report_id, header, model)
    field_by_header = {field["source"].split(":", 1)[1]: field for field in dataset["fields"]}
    segment_start = file_meta["segment_start_date"]
    segment_end = file_meta["segment_end_date"]
    source_sheet = f"csv:{segment_start}:{segment_end}"
    rows: list[dict[str, Any]] = []
    signatures: Counter[tuple[Any, ...]] = Counter()
    for row_number, values in enumerate(physical_rows[1:], start=2):
        if len(values) != len(header):
            raise CleaningError("row_width_mismatch", f"ratings row width differs: {path}:{row_number}")
        if all(not str(value).strip() for value in values):
            raise CleaningError("unexpected_blank_row", f"ratings CSV contains a blank row: {path}:{row_number}")
        parsed = _base_row(manifest, report_id, file_meta, source_sheet, row_number, batch_id)
        for column, value in zip(header, values):
            field = field_by_header[column]
            parsed[field["name"]] = _convert(value, field)
        rating = int(parsed["rating"])
        if rating < 1 or rating > 5:
            raise CleaningError("rating_out_of_range", f"rating must be between 1 and 5: {path}:{row_number}")
        parsed["source_row_key"] = _source_row_key(file_meta["sha256"], source_sheet, row_number)
        parsed["record_key"] = record_key(dataset["name"], [parsed.get(name) for name in dataset["record_key_components"]])
        parsed["record_content_hash"] = _content_hash(dataset["name"], parsed, dataset["content_fields"])
        signatures[tuple(parsed.get(name) for name in dataset["content_fields"])] += 1
        rows.append(parsed)
    if len(rows) != file_meta["official_total_count"]:
        raise CleaningError("official_total_count_mismatch", f"ratings CSV row count differs from Manifest: {path}")
    duplicate_groups = sum(1 for count in signatures.values() if count > 1)
    duplicate_rows = sum(count - 1 for count in signatures.values() if count > 1)
    qa = {
        "source_file": str(path), "source_rows_excluding_header": len(physical_rows) - 1,
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": len(rows) == len(physical_rows) - 1,
        "summary_reconciliation": {"status": "not_applicable"},
        "segment_start_date": segment_start, "segment_end_date": segment_end,
        "official_total_count": file_meta["official_total_count"],
        "exact_duplicate_signature_groups": duplicate_groups,
        "exact_duplicate_rows_beyond_first": duplicate_rows,
        "duplicate_policy": "preserved_no_review_id_available",
    }
    return dataset["name"], rows, qa
