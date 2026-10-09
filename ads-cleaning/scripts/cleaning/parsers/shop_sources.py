"""Parsers for the three shop-owned API sources added in stage 6-5-4D."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from record_key import record_key

from ..conversion import _decimal, _integer, _optional_string, _required_string
from ..errors import CleaningError
from ..records import _base_row, _content_hash, _source_row_key

SNAPSHOT_SCHEMA = "seller_shop_api_snapshot_v1"
SOURCE_IDS = {
    "shop_video_performance": "seller_shop_video_performance_v1",
    "shop_gmv_source_breakdown_daily": "seller_shop_gmv_source_breakdown_daily_v1",
    "shop_product_growth_opportunity_snapshot": "seller_shop_product_growth_opportunity_snapshot_v1",
    "shop_product_commercial_status_snapshot": "seller_shop_product_commercial_status_snapshot_v1",
}
REPORT_TO_DATASET = {
    "shop_video_performance": "shop_video_performance",
    "shop_gmv_source_breakdown_daily": "shop_gmv_source_breakdown_daily",
    "shop_product_growth_opportunity_snapshot": "shop_product_growth_opportunity_snapshot",
}


def _read(path: Path, report_id: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleaningError("snapshot_unreadable", f"cannot read shop API snapshot: {path}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != SNAPSHOT_SCHEMA:
        raise CleaningError("snapshot_schema_mismatch", f"unexpected shop API snapshot schema: {path}")
    if value.get("source_id") != SOURCE_IDS[report_id]:
        raise CleaningError("snapshot_source_mismatch", f"shop API source does not match report: {path}")
    response = value.get("response")
    if not isinstance(response, dict) or response.get("code") != 0:
        raise CleaningError("api_response_error", f"shop API response is not successful: {path}")
    return value


def _dataset(model: dict[str, Any], name: str) -> dict[str, Any]:
    for item in model.get("datasets", []):
        if item.get("name") == name:
            return item
    raise CleaningError("unknown_dataset", f"unknown shop source dataset: {name}")


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _finish(dataset: dict[str, Any], row: dict[str, Any], file_meta: dict[str, Any], row_number: int) -> dict[str, Any]:
    row["record_key"] = record_key(dataset["name"], [row.get(name) for name in dataset["record_key_components"]])
    row["source_row_key"] = _source_row_key(file_meta["sha256"], "api_response", row_number)
    row["record_content_hash"] = _content_hash(dataset["name"], row, dataset["content_fields"])
    return row


def _base_shop_row(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], batch_id: str, row_number: int) -> dict[str, Any]:
    row = _base_row(manifest, report_id, file_meta, "api_response", row_number, batch_id)
    row.pop("advertiser_id", None)
    row.pop("advertiser_name", None)
    return row


def _captured(snapshot: dict[str, Any]) -> str:
    value = snapshot.get("captured_at_utc")
    if not isinstance(value, str):
        raise CleaningError("snapshot_capture_missing", "shop API snapshot captured_at_utc is missing")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError as exc:
        raise CleaningError("invalid_utc_datetime", "shop API snapshot captured_at_utc is invalid") from exc


def _parse_video(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str, snapshot: dict[str, Any]) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    dataset = _dataset(model, REPORT_TO_DATASET[report_id]); response = snapshot["response"]; segments = response.get("data", {}).get("segments")
    stats = [stat for segment in (segments or []) for timed in segment.get("timed_lists", []) for stat in timed.get("stats", [])]
    collection = snapshot.get("collection", {})
    if collection.get("pagination_complete") is not True or collection.get("collected_count") != len(stats):
        raise CleaningError("pagination_count_mismatch", "video snapshot collection count differs from rows")
    captured = _captured(snapshot); rows = []
    for number, stat in enumerate(stats, start=1):
        video_meta = stat.get("video_meta") or {}; creator = stat.get("creator_meta") or {}; video = stat.get("video") or {}; revenue = stat.get("revenue") or {}
        publish_time = video_meta.get("publish_time")
        published_at = datetime.fromtimestamp(int(publish_time), tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") if publish_time is not None else None
        row = _base_shop_row(manifest, report_id, file_meta, batch_id, number)
        row.update({"video_id": _required_string(video_meta.get("id"), "video_meta.id"), "creator_id": _optional_string(creator.get("id")), "creator_handle": _optional_string(creator.get("handle")), "creator_name": _optional_string(creator.get("alias")), "video_title": _optional_string(video_meta.get("name")), "published_at_utc": published_at, "exploration_status": _optional_string(stat.get("diagnosis_id")), "video_boost_status": _optional_string(stat.get("video_boost_status")), "view_count": _integer(stat.get("view_cnt", 0), "view_cnt"), "item_exposure_count": _integer(stat.get("item_exposure_cnt", 0), "item_exposure_cnt"), "item_click_count": _integer(stat.get("item_click_cnt", 0), "item_click_cnt"), "sku_order_count": _integer(stat.get("sku_order_cnt", 0), "sku_order_cnt"), "gross_revenue": _decimal(revenue.get("amount", 0), "revenue.amount"), "currency": _optional_string(revenue.get("currency_code")), "captured_at_utc": captured, "raw_video_json": _json_text(stat)})
        rows.append(_finish(dataset, row, file_meta, number))
    if len({row["record_key"] for row in rows}) != len(rows):
        raise CleaningError("record_key_duplicate", "duplicate video record key")
    return dataset["name"], rows, {"source_file": file_meta["path"], "source_rows_excluding_header": len(stats), "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0, "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"}}


def _parse_gmv(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str, snapshot: dict[str, Any]) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    dataset = _dataset(model, REPORT_TO_DATASET[report_id]); rows = []; response_data = snapshot["response"].get("data") or []; captured = _captured(snapshot)
    expected_start = str(manifest["request"]["start_date"])
    expected_end_exclusive = (date.fromisoformat(str(manifest["request"]["end_date"])) + timedelta(days=1)).isoformat()
    for block in response_data:
        for interval in block.get("intervals", []):
            start = _required_string(interval.get("start_date"), "interval.start_date"); end = _required_string(interval.get("end_date"), "interval.end_date")
            if start != expected_start or end != expected_end_exclusive:
                raise CleaningError("gmv_interval_date_boundary_mismatch", f"expected [{expected_start}, {expected_end_exclusive}), observed [{start}, {end})")
            for source_row in interval.get("rows", []):
                values = source_row.get("values") or {}
                for metric_id, raw in values.items():
                    parsed = json.loads(raw) if isinstance(raw, str) else raw
                    if not isinstance(parsed, dict): raise CleaningError("gmv_metric_shape_mismatch", "GMV metric value must be an object")
                    value = parsed.get("value")
                    currency = parsed.get("currency_code")
                    row = _base_shop_row(manifest, report_id, file_meta, batch_id, len(rows) + 1)
                    row.update({"query_start_date": start, "query_end_date_exclusive": end, "metric_id": _required_string(metric_id, "metric_id"), "metric_value_official": _optional_string(value), "currency": _optional_string(currency), "captured_at_utc": captured, "metric_json": _json_text(parsed)})
                    rows.append(_finish(dataset, row, file_meta, len(rows) + 1))
    collection = snapshot.get("collection", {})
    interval_count = sum(len(block.get("intervals", [])) for block in response_data)
    if not response_data or collection.get("pagination_complete") is not True or collection.get("collected_count") != interval_count:
        raise CleaningError("gmv_collection_incomplete", "GMV snapshot collection proof is missing")
    return dataset["name"], rows, {"source_file": file_meta["path"], "source_rows_excluding_header": len(rows), "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0, "row_conservation": True, "summary_reconciliation": {"status": "not_applicable", "query_end_date_exclusive": True}}


def _parse_growth(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str, snapshot: dict[str, Any]) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    dataset = _dataset(model, REPORT_TO_DATASET[report_id]); response = snapshot["response"]; products = response.get("data", {}).get("products") or []; collection = snapshot.get("collection", {})
    if collection.get("pagination_complete") is not True or collection.get("collected_count") != len(products): raise CleaningError("pagination_count_mismatch", "growth snapshot collection count differs from rows")
    captured = _captured(snapshot); rows = []
    for number, product in enumerate(products, start=1):
        row = _base_shop_row(manifest, report_id, file_meta, batch_id, number)
        row.update({"latest_date": _optional_string(snapshot.get("request", {}).get("latest_date")), "product_id": _required_string(product.get("product_id"), "product_id"), "product_title": _optional_string(product.get("product_title")), "historical_orders": _integer(product.get("total_historical_orders", 0), "total_historical_orders"), "high_growth_potential": _optional_string(product.get("high_growth_potential") if product.get("high_growth_potential") is not None else product.get("is_pontos_target")), "completed_tasks_json": _json_text(product.get("completed_tasks", [])), "suggested_task": _optional_string(product.get("suggest_task")), "suggested_tasks_json": _json_text(product.get("suggest_task_list", [])), "task_benefit_json": _json_text(product.get("task_benefit", [])), "trend_word": _optional_string(product.get("trend_word")), "captured_at_utc": captured, "raw_product_json": _json_text(product)})
        rows.append(_finish(dataset, row, file_meta, number))
    return dataset["name"], rows, {"source_file": file_meta["path"], "source_rows_excluding_header": len(products), "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0, "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"}}


def _parse_shop_source(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    snapshot = _read(Path(file_meta["path"]), report_id)
    if report_id == "shop_product_commercial_status_snapshot":
        from .product_commercial import parse_product_commercial
        return parse_product_commercial(manifest, report_id, file_meta, model, batch_id, snapshot)
    if report_id == "shop_video_performance": return _parse_video(manifest, report_id, file_meta, model, batch_id, snapshot)
    if report_id == "shop_gmv_source_breakdown_daily": return _parse_gmv(manifest, report_id, file_meta, model, batch_id, snapshot)
    return _parse_growth(manifest, report_id, file_meta, model, batch_id, snapshot)
