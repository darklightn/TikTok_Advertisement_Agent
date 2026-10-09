"""Parsers for immutable Seller Center API snapshot envelopes."""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

from record_key import record_key

from ..conversion import (
    _date_value,
    _datetime_value,
    _decimal,
    _hour_value,
    _integer,
    _optional_string,
    _required_string,
    _utc_datetime_value,
)
from ..errors import CleaningError
from ..records import _add_ad_calculations, _base_row, _content_hash, _source_row_key


SNAPSHOT_SCHEMAS = {"seller_api_snapshot_v1", "seller_api_snapshot_v2", "seller_gmvmax_campaign_hourly_snapshot_v1"}
SOURCE_IDS = {
    "gmvmax_campaign_hourly_performance": "seller_gmvmax_campaign_hourly_v1",
    "gmvmax_campaign_current_configuration_snapshot": "seller_gmvmax_campaign_current_configuration_snapshot_v1",
    "gmvmax_campaign_performance_interval": "seller_gmvmax_campaign_list_interval_v1",
    "gmvmax_campaign_daily_performance": "seller_gmvmax_campaign_detail_daily_v1",
    "gmvmax_campaign_change_log": "seller_gmvmax_campaign_change_log_v1",
    "gmvmax_campaign_recommendation_snapshot": "seller_gmvmax_campaign_recommendation_snapshot_v1",
    "gmvmax_campaign_upgrade_session_snapshot": "seller_gmvmax_campaign_upgrade_session_snapshot_v1",
}
SOURCE_IDS_V2 = {
    "gmvmax_campaign_hourly_performance": "seller_gmvmax_campaign_hourly_v1",
    "gmvmax_campaign_current_configuration_snapshot": "seller_gmvmax_campaign_current_configuration_snapshot_v2",
    "gmvmax_campaign_performance_interval": "seller_gmvmax_campaign_list_interval_v2",
    "gmvmax_campaign_daily_performance": "seller_gmvmax_campaign_daily_v2",
    "gmvmax_campaign_change_log": "seller_gmvmax_campaign_change_log_v2",
    "gmvmax_campaign_recommendation_snapshot": "seller_gmvmax_campaign_recommendation_snapshot_v2",
    "gmvmax_campaign_upgrade_session_snapshot": "seller_gmvmax_campaign_upgrade_session_snapshot_v2",
}
SOURCE_IDS_V3 = {
    "gmvmax_campaign_daily_performance": "seller_gmvmax_campaign_daily_v3",
    "gmvmax_campaign_product_daily_performance": "seller_gmvmax_campaign_product_daily_v1",
}
SNAPSHOT_REPORT_IDS = set(SOURCE_IDS) | set(SOURCE_IDS_V2) | set(SOURCE_IDS_V3)
REPORT_TO_DATASET = {
    "gmvmax_campaign_hourly_performance": "gmvmax_campaign_hourly_performance",
    "gmvmax_campaign_current_configuration_snapshot": "gmvmax_campaign_current_configuration_snapshot",
    "gmvmax_campaign_performance_interval": "gmvmax_campaign_performance_interval",
    "gmvmax_campaign_daily_performance": "gmvmax_campaign_daily_performance",
    "gmvmax_campaign_product_daily_performance": "gmvmax_campaign_product_daily",
    "gmvmax_campaign_change_log": "gmvmax_campaign_change_log",
    "gmvmax_campaign_recommendation_snapshot": "gmvmax_campaign_recommendation_snapshot",
    "gmvmax_campaign_upgrade_session_snapshot": "gmvmax_campaign_upgrade_session_snapshot",
}


def _read_snapshot(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleaningError("snapshot_unreadable", f"cannot read API snapshot: {path}") from exc
    if not isinstance(value, dict):
        raise CleaningError("snapshot_invalid", f"API snapshot must be an object: {path}")
    if value.get("schema_version") not in SNAPSHOT_SCHEMAS:
        raise CleaningError("snapshot_schema_mismatch", f"unexpected API snapshot schema: {path}")
    return value


def _json_text(value: Any, field: str) -> str | None:
    if value is None:
        return None
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise CleaningError("snapshot_value_unserializable", f"cannot serialize {field}") from exc


def _optional_decimal(value: Any, field: str) -> str | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    return _decimal(value, field)


def _optional_integer(value: Any, field: str) -> str | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    return _integer(value, field)


def _validate_official_ctr(impressions: str, clicks: str, ctr_official: str) -> None:
    impression_count = Decimal(impressions)
    click_count = Decimal(clicks)
    official = Decimal(ctr_official)
    if impression_count < 0 or click_count < 0 or official < 0:
        raise CleaningError("campaign_daily_funnel_invalid", "campaign daily funnel metrics must be nonnegative")
    if impression_count == 0:
        if click_count != 0 or official != 0:
            raise CleaningError("campaign_daily_funnel_invalid", "zero impressions conflict with clicks or official CTR")
        return
    calculated = click_count * Decimal("100") / impression_count
    if abs(calculated - official) > Decimal("0.01"):
        raise CleaningError("campaign_daily_funnel_invalid", "official CTR differs from clicks / impressions")


def _snapshot_currency(file_meta: dict[str, Any]) -> str:
    return _required_string(file_meta.get("currency"), "file.currency")


def _response(snapshot: dict[str, Any], path: Path) -> dict[str, Any]:
    response = snapshot.get("response")
    if not isinstance(response, dict):
        raise CleaningError("snapshot_response_missing", f"response is missing: {path}")
    if snapshot.get("schema_version") == "seller_api_snapshot_v2" and response.get("code") is None and isinstance(response.get("records"), list):
        return response
    if response.get("code") != 0:
        raise CleaningError("api_response_error", f"API response code is not zero: {path}")
    return response


def _captured(snapshot: dict[str, Any], file_meta: dict[str, Any], path: Path) -> str:
    value = _utc_datetime_value(snapshot.get("captured_at_utc"), "snapshot.captured_at_utc")
    expected = _utc_datetime_value(file_meta.get("captured_at_utc"), "file.captured_at_utc")
    if value != expected:
        raise CleaningError("snapshot_capture_mismatch", f"snapshot capture time differs from Manifest: {path}")
    return value


def _pagination_complete(
    snapshot: dict[str, Any], data: dict[str, Any], count: int, path: Path, *,
    collected_count_field: str = "collected_count", validate_official_total: bool = True,
) -> None:
    collection = snapshot.get("collection")
    if snapshot.get("schema_version") == "seller_api_snapshot_v2":
        if not isinstance(collection, dict) or collection.get("pagination_complete") is not True:
            raise CleaningError("pagination_incomplete", f"API snapshot does not prove complete pagination: {path}")
        collected = collection.get(collected_count_field)
        if collected != count:
            raise CleaningError("pagination_count_mismatch", f"collection count differs from rows: {path}")
        official = collection.get("official_total_count")
        if validate_official_total and official is not None and official != count:
            raise CleaningError("pagination_count_mismatch", f"official total differs from rows: {path}")
        return
    pagination = data.get("pagination")
    if not isinstance(collection, dict) or collection.get("pagination_complete") is not True:
        raise CleaningError("pagination_incomplete", f"API snapshot does not prove complete pagination: {path}")
    if not isinstance(pagination, dict):
        raise CleaningError("pagination_missing", f"API snapshot pagination is missing: {path}")
    total = pagination.get("total_count")
    if not isinstance(total, int) or total < 0 or total != count:
        raise CleaningError("pagination_count_mismatch", f"API snapshot row count differs from pagination: {path}")
    collected = collection.get("collected_count", count)
    if collected != count:
        raise CleaningError("pagination_count_mismatch", f"collection count differs from rows: {path}")


def _dataset(model: dict[str, Any], name: str) -> dict[str, Any]:
    for item in model.get("datasets", []):
        if item.get("name") == name:
            return item
    raise CleaningError("unknown_dataset", f"unknown snapshot dataset: {name}")


def _finish(
    dataset: dict[str, Any], row: dict[str, Any], file_meta: dict[str, Any], row_number: int,
) -> dict[str, Any]:
    row["record_key"] = record_key(dataset["name"], [row.get(name) for name in dataset["record_key_components"]])
    row["source_row_key"] = _source_row_key(file_meta["sha256"], "api_response", row_number)
    row["record_content_hash"] = _content_hash(dataset["name"], row, dataset["content_fields"])
    return row


def _base_snapshot_row(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], batch_id: str, captured_at: str,
    row_number: int,
) -> dict[str, Any]:
    row = _base_row(manifest, report_id, file_meta, "api_response", row_number, batch_id)
    row["captured_at_utc"] = captured_at
    return row


def _require_campaign_id(value: Any, field: str = "campaign_id") -> str:
    return _required_string(str(value) if value is not None else None, field)


def _assert_campaign_binding(file_meta: dict[str, Any], campaign_id: str, snapshot: dict[str, Any] | None = None) -> None:
    identity = (snapshot or {}).get("identity") or {}
    bound = _require_campaign_id(file_meta.get("campaign_id") or identity.get("campaign_id"), "snapshot campaign binding")
    if bound != campaign_id:
        raise CleaningError("campaign_identity_mismatch", "snapshot campaign differs from Manifest file binding")


def _parse_campaign_hourly(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], response: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    identity = snapshot.get("identity") if isinstance(snapshot.get("identity"), dict) else snapshot
    campaign_id = _require_campaign_id(identity.get("campaign_id"), "snapshot campaign_id")
    _assert_campaign_binding(file_meta, campaign_id, snapshot)
    metric_date = _date_value(identity.get("metric_date") or snapshot.get("metric_date"), "snapshot metric_date")
    if _date_value(file_meta.get("metric_date"), "file.metric_date") != metric_date:
        raise CleaningError("metric_date_mismatch", f"snapshot date differs from Manifest: {path}")
    request_body = (snapshot.get("request") or {}).get("body")
    if not isinstance(request_body, dict) or [str(value) for value in request_body.get("campaign_ids") or []] != [campaign_id]:
        raise CleaningError("campaign_identity_mismatch", f"hourly request is not bound to one campaign: {path}")
    if request_body.get("start_time") != metric_date or request_body.get("end_time") != metric_date:
        raise CleaningError("metric_date_mismatch", f"hourly request is not bound to one natural day: {path}")
    data = response.get("data")
    chart = data.get("chart") if isinstance(data, dict) else None
    categories = chart.get("categories") if isinstance(chart, dict) else None
    expected_categories = [f"{hour:02d}:00" for hour in range(24)]
    if categories != expected_categories:
        raise CleaningError("campaign_hourly_categories_incomplete", f"hour categories must be exactly 00:00 through 23:00: {path}")
    series_source = chart.get("series")
    if not isinstance(series_source, list):
        raise CleaningError("campaign_hourly_series_incomplete", f"hour series is missing: {path}")
    series: dict[str, list[Any]] = {}
    for item in series_source:
        name = item.get("name") if isinstance(item, dict) else None
        values = item.get("data") if isinstance(item, dict) else None
        if not isinstance(name, str) or name in series or not isinstance(values, list) or len(values) != 24:
            raise CleaningError("campaign_hourly_series_incomplete", f"hour series must have one unique 24-value array: {path}")
        series[name] = values
    metrics = {
        "cost": ("cost", _decimal),
        "sku_orders": ("onsite_roi2_shopping_sku", _integer),
        "cost_per_order_official": ("cost_per_onsite_roi2_shopping_sku", _decimal),
        "gross_revenue": ("onsite_roi2_shopping_value", _decimal),
        "roi_official": ("onsite_roi2_shopping", _decimal),
    }
    missing = [source for source, _converter in metrics.values() if source not in series]
    if missing:
        raise CleaningError("campaign_hourly_series_incomplete", f"required hour series is missing: {','.join(missing)}")
    if snapshot.get("schema_version") == "seller_api_snapshot_v2":
        collection = snapshot.get("collection")
        if not isinstance(collection, dict) or collection.get("pagination_complete") is not True or collection.get("collected_count") != 24:
            raise CleaningError("pagination_incomplete", f"hourly snapshot does not prove 24-hour collection: {path}")
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    currency = _snapshot_currency(file_meta)
    rows = []
    for index, category in enumerate(categories, start=1):
        values = {field: converter(series[source][index - 1], field) for field, (source, converter) in metrics.items()}
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, index)
        row["currency"] = currency
        row.update({
            "campaign_id": campaign_id,
            "campaign_name_observed": _optional_string(identity.get("campaign_name") or snapshot.get("campaign_name")),
            "metric_date": metric_date,
            "metric_hour": _hour_value(f"{metric_date}T{category}:00", "metric_hour"),
            "captured_at_utc": captured_at,
            **values,
            "raw_hour_json": _json_text({name: values[index - 1] for name, values in sorted(series.items())}, "hour series"),
        })
        _add_ad_calculations(row)
        rows.append(_finish(dataset, row, file_meta, index))
    statistics = data.get("statistics") if isinstance(data, dict) else None
    if not isinstance(statistics, dict):
        raise CleaningError("campaign_hourly_summary_missing", f"official hourly summary is missing: {path}")
    profiles = model["qa_contract"]["currency_tolerance_policy"]["profiles"]
    profile = next((item for item in profiles if item.get("report_id") == report_id and item.get("currency") == currency), None)
    if profile is None:
        raise CleaningError("currency_tolerance_unapproved", f"no approved hourly tolerance for {currency}")
    checks = []
    for field, source in (("cost", "cost"), ("sku_orders", "onsite_roi2_shopping_sku"), ("gross_revenue", "onsite_roi2_shopping_value")):
        actual = sum(Decimal(row[field]) for row in rows)
        expected = Decimal(_integer(statistics.get(source), field)) if field == "sku_orders" else Decimal(_decimal(statistics.get(source), field))
        tolerance = Decimal("0") if field == "sku_orders" else Decimal(profile["field_absolute_tolerance"][field])
        difference = abs(actual - expected)
        checks.append({"field": field, "detail_sum": format(actual, "f"), "official_summary": format(expected, "f"), "absolute_difference": format(difference, "f"), "tolerance": format(tolerance, "f"), "passed": difference <= tolerance})
    if not all(item["passed"] for item in checks):
        raise CleaningError("summary_reconciliation_failed", f"official campaign-hour summary differs for {campaign_id}/{metric_date}")
    return dataset["name"], rows, {
        "source_file": file_meta["path"], "source_rows_excluding_header": 25,
        "detail_rows": 24, "summary_rows": 1, "fact_summary_rows": 0,
        "blank_rows": 0, "rejected_rows": 0, "row_conservation": True,
        "hour_sequence_complete": True,
        "summary_reconciliation": {"status": "passed", "currency": currency, "checks": checks, "official_ratios_preserved": True},
    }


def _parse_configuration(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], response: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    data = response.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("ad_info"), dict):
        raise CleaningError("snapshot_shape_mismatch", "configuration response lacks ad_info")
    ad_info = data["ad_info"]
    campaign_info = data.get("campaign_info") if isinstance(data.get("campaign_info"), dict) else {}
    campaign_id = _require_campaign_id(ad_info.get("campaign_id") or campaign_info.get("campaign_id"))
    _assert_campaign_binding(file_meta, campaign_id, snapshot)
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, 1)
    row["currency"] = _snapshot_currency(file_meta) if snapshot.get("schema_version") == "seller_api_snapshot_v2" else None
    row.update({
        "campaign_id": campaign_id,
        "campaign_name": _optional_string(campaign_info.get("campaign_name") or ad_info.get("name")),
        "ad_id": _optional_string(ad_info.get("ad_id")),
        "budget": _optional_decimal(ad_info.get("budget"), "budget"),
        "roas_bid": _optional_decimal(ad_info.get("roas_bid"), "roas_bid"),
        "budget_mode_raw": _optional_string(
            campaign_info.get("budget_mode") if campaign_info.get("budget_mode") is not None else ad_info.get("budget_mode")
        ),
        "start_time_raw": _optional_string(ad_info.get("start_time")),
        "end_time_raw": _optional_string(ad_info.get("end_time")),
        "optimize_goal_raw": _optional_string(ad_info.get("optimize_goal")),
        "promotion_days_setting_json": _json_text(ad_info.get("promotion_days_setting"), "promotion_days_setting"),
        "gmax_budget_adjust_setting_json": _json_text(ad_info.get("gmax_budget_adjust_setting"), "gmax_budget_adjust_setting"),
        "product_list_json": _json_text(ad_info.get("product_list"), "product_list"),
        "audience_json": _json_text(ad_info.get("audience"), "audience"),
        "raw_campaign_info_json": _json_text(campaign_info, "campaign_info"),
        "raw_ad_info_json": _json_text(ad_info, "ad_info"),
    })
    if row["ad_id"] is None:
        raise CleaningError("required_identity_missing", "configuration ad_info.ad_id is missing")
    return dataset["name"], [_finish(dataset, row, file_meta, 1)], {
        "source_file": file_meta["path"], "source_rows_excluding_header": 1, "detail_rows": 1,
        "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0, "row_conservation": True,
        "summary_reconciliation": {"status": "not_applicable"},
    }


def _parse_performance_interval(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], response: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    data = response.get("data")
    rows_source = response.get("records") if snapshot.get("schema_version") == "seller_api_snapshot_v2" else data.get("table") if isinstance(data, dict) else None
    if not isinstance(rows_source, list):
        raise CleaningError("snapshot_shape_mismatch", "campaign performance response lacks table")
    _pagination_complete(snapshot, data if isinstance(data, dict) else {}, len(rows_source), Path(file_meta["path"]))
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    rows = []
    seen_campaigns: set[str] = set()
    currency = _snapshot_currency(file_meta)
    for index, source in enumerate(rows_source, start=1):
        if not isinstance(source, dict):
            raise CleaningError("snapshot_shape_mismatch", f"campaign performance row is not an object: {index}")
        campaign_id = _require_campaign_id(source.get("campaign_id"), f"table[{index}].campaign_id")
        if campaign_id in seen_campaigns:
            raise CleaningError("record_key_duplicate", f"duplicate campaign row: {campaign_id}")
        seen_campaigns.add(campaign_id)
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, index)
        row["currency"] = currency
        row.update({
            "campaign_id": campaign_id,
            "campaign_name": _optional_string(source.get("campaign_name")),
            "campaign_budget_mode_raw": _optional_string(source.get("campaign_budget_mode")),
            "campaign_primary_status_raw": _optional_string(source.get("campaign_primary_status")),
            "campaign_opt_status_raw": _optional_string(source.get("campaign_opt_status")),
            "campaign_status_raw": _optional_string(source.get("campaign_status")),
            "schedule_type_raw": _optional_string(source.get("template_ad_schedule_type")),
            "schedule_start_time_raw": _optional_string(source.get("template_ad_start_time")),
            "schedule_end_time_raw": _optional_string(source.get("template_ad_end_time")),
            "target_roi": _optional_decimal(source.get("template_ad_roas_bid"), "template_ad_roas_bid"),
            "budget": _optional_decimal(source.get("campaign_target_roi_budget"), "campaign_target_roi_budget"),
            "campaign_target_roi_budget_mode_raw": _optional_string(source.get("campaign_target_roi_budget_mode")),
            "no_bid_budget": _optional_decimal(source.get("campaign_no_bid_budget"), "campaign_no_bid_budget"),
            "additional_budget": _optional_decimal(source.get("campaign_additional_budget"), "campaign_additional_budget"),
            "promotion_days_mode_raw": _optional_string(source.get("promotion_days_mode")),
            "in_promotion_days_raw": _optional_string(source.get("in_promotion_days")),
            "promotion_days_roas_bid_multiplier": _optional_decimal(source.get("promotion_days_roas_bid_multiplier"), "promotion_days_roas_bid_multiplier"),
            "promotion_days_budget_multiplier": _optional_decimal(source.get("promotion_days_budget_multiplier"), "promotion_days_budget_multiplier"),
            "promotion_days_schedules_json": _json_text(source.get("promotion_days_schedules"), "promotion_days_schedules"),
            "campaign_create_channel_raw": _optional_string(source.get("campaign_create_channel")),
            "auto_increase_budget_effective_budget": _optional_decimal(source.get("auto_increase_budget_effective_budget"), "auto_increase_budget_effective_budget"),
            "gmax_advance_mode_raw": _optional_string(source.get("gmax_advance_mode")),
            "current_optimization_mode_raw": _optional_string(source.get("current_optimization_mode")),
            "cost": _optional_decimal(source.get("cost"), "cost"),
            "billed_cost": _optional_decimal(source.get("billed_cost"), "billed_cost"),
            "boost_cost": _optional_decimal(source.get("all_boost_cost"), "all_boost_cost"),
            "creative_nobid_cost": _optional_decimal(source.get("creative_nobid_cost"), "creative_nobid_cost"),
            "sku_orders": _optional_integer(source.get("onsite_roi2_shopping_sku"), "onsite_roi2_shopping_sku"),
            "gross_revenue": _optional_decimal(source.get("onsite_roi2_shopping_value"), "onsite_roi2_shopping_value"),
            "cost_per_order_official": _optional_decimal(source.get("cost_per_onsite_roi2_shopping_sku"), "cost_per_onsite_roi2_shopping_sku"),
            "roi_official": _optional_decimal(source.get("onsite_roi2_shopping"), "onsite_roi2_shopping"),
            "basic_cost": _optional_decimal(source.get("basic_cost"), "basic_cost"),
            "basic_roi_official": _optional_decimal(source.get("basic_onsite_roi2_shopping"), "basic_onsite_roi2_shopping"),
            "campaign_budget_utilization_status_raw": _optional_string(source.get("campaign_budget_utilization_status")),
            "campaign_budget_utilization_today_threshold": _optional_decimal(source.get("campaign_budget_utilization_today_threshold"), "campaign_budget_utilization_today_threshold"),
            "campaign_budget_utilization_yesterday_threshold": _optional_decimal(source.get("campaign_budget_utilization_yesterday_threshold"), "campaign_budget_utilization_yesterday_threshold"),
            "gmv_max_bid_type_raw": _optional_string(source.get("gmv_max_bid_type")),
            "compensation_info_json": _json_text(source.get("compensation_info"), "compensation_info"),
            "campaign_eligible_status_raw": _optional_string(source.get("campaign_eligible_status")),
            "campaign_eligible_reject_reason_raw": _optional_string(source.get("campaign_eligible_reject_reason")),
            "campaign_eligible_roi": _optional_decimal(source.get("campaign_eligible_roi"), "campaign_eligible_roi"),
            "session_info_json": _json_text(source.get("session_info"), "session_info"),
            "raw_row_json": _json_text(source, "campaign_performance_row"),
        })
        _add_ad_calculations(row)
        rows.append(_finish(dataset, row, file_meta, index))
    return dataset["name"], rows, {
        "source_file": file_meta["path"], "source_rows_excluding_header": len(rows_source),
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"},
    }


def _parse_daily(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], response: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    if snapshot.get("schema_version") == "seller_api_snapshot_v2":
        records = response.get("records")
        if not isinstance(records, list):
            raise CleaningError("snapshot_shape_mismatch", "campaign daily response lacks records")
        collection = snapshot.get("collection") or {}
        selected_campaign_ids = collection.get("selected_campaign_ids")
        if collection.get("pagination_complete") is not True or not isinstance(selected_campaign_ids, list):
            raise CleaningError("pagination_incomplete", f"campaign daily collection is incomplete: {file_meta['path']}")
        selected_count = len(set(str(value) for value in selected_campaign_ids))
        if collection.get("official_total_count") != selected_count or collection.get("collected_count") != selected_count:
            raise CleaningError("pagination_count_mismatch", f"campaign daily universe count is inconsistent: {file_meta['path']}")
        if collection.get("observed_campaign_count") != len(records):
            raise CleaningError("pagination_count_mismatch", f"campaign daily record count is inconsistent: {file_meta['path']}")
        expected_coverage = collection.get("expected_coverage_unit_count")
        completed_coverage = collection.get("completed_coverage_unit_count")
        if not isinstance(expected_coverage, int) or completed_coverage != expected_coverage or len(records) > completed_coverage:
            raise CleaningError("pagination_count_mismatch", f"campaign daily coverage count is inconsistent: {file_meta['path']}")
        dataset = _dataset(model, REPORT_TO_DATASET[report_id])
        currency = _snapshot_currency(file_meta)
        start = _date_value(manifest["request"]["start_date"], "request.start_date")
        end = _date_value(manifest["request"]["end_date"], "request.end_date")
        rows = []
        seen: set[tuple[str, str]] = set()
        for index, source in enumerate(records, start=1):
            if not isinstance(source, dict):
                raise CleaningError("snapshot_shape_mismatch", f"campaign daily row is not an object: {index}")
            campaign_id = _require_campaign_id(source.get("campaign_id"), f"records[{index}].campaign_id")
            metric_date = _date_value(source.get("metric_date"), f"records[{index}].metric_date")
            if metric_date < start or metric_date > end:
                raise CleaningError("chart_date_out_of_range", f"campaign daily date is outside request: {metric_date}")
            if (campaign_id, metric_date) in seen:
                raise CleaningError("record_key_duplicate", f"duplicate campaign daily row: {campaign_id}/{metric_date}")
            seen.add((campaign_id, metric_date))
            row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, index)
            row["currency"] = _required_string(source.get("currency"), "records.currency")
            if row["currency"] != currency:
                raise CleaningError("currency_inconsistent", "daily row currency differs from Manifest evidence")
            source_v3 = snapshot.get("source_id") == SOURCE_IDS_V3["gmvmax_campaign_daily_performance"]
            impressions = _integer(source.get("impressions"), "records.impressions") if source_v3 else None
            clicks = _integer(source.get("clicks"), "records.clicks") if source_v3 else None
            ctr_official = _decimal(source.get("ctr_official"), "records.ctr_official") if source_v3 else None
            if source_v3:
                _validate_official_ctr(impressions, clicks, ctr_official)
            row.update({
                "campaign_id": campaign_id,
                "metric_date": metric_date,
                "cost": _decimal(source.get("cost"), "records.cost"),
                "impressions": impressions,
                "clicks": clicks,
                "ctr_official": ctr_official,
                "sku_orders": _integer(source.get("sku_orders"), "records.sku_orders"),
                "cost_per_order_official": _decimal(source.get("cost_per_order_official"), "records.cost_per_order_official"),
                "gross_revenue": _decimal(source.get("gross_revenue"), "records.gross_revenue"),
                "roi_official": _decimal(source.get("roi_official"), "records.roi_official"),
                "sns_opt_gross_revenue": None,
                "sns_opt_roi_official": None,
                "raw_series_json": _json_text(source, "daily_record"),
            })
            _add_ad_calculations(row)
            rows.append(_finish(dataset, row, file_meta, index))
        return dataset["name"], rows, {
            "source_file": file_meta["path"], "source_rows_excluding_header": len(records),
            "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
            "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"},
        }
    data = response.get("data")
    chart = data.get("chart") if isinstance(data, dict) else None
    categories = chart.get("categories") if isinstance(chart, dict) else None
    series = chart.get("series") if isinstance(chart, dict) else None
    if not isinstance(categories, list) or not isinstance(series, list) or not categories:
        raise CleaningError("snapshot_shape_mismatch", "campaign daily response lacks chart categories or series")
    by_name = {item.get("name"): item.get("data") for item in series if isinstance(item, dict) and item.get("name")}
    required = {"cost", "onsite_roi2_shopping_sku", "cost_per_onsite_roi2_shopping_sku", "onsite_roi2_shopping_value", "onsite_roi2_shopping"}
    if not required.issubset(by_name):
        missing = ",".join(sorted(required - set(by_name)))
        raise CleaningError("chart_series_missing", f"campaign daily chart lacks series: {missing}")
    if any(not isinstance(values, list) or len(values) != len(categories) for values in by_name.values()):
        raise CleaningError("chart_series_length_mismatch", "campaign daily series lengths differ from categories")
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    campaign_id = _require_campaign_id(file_meta.get("campaign_id"), "file.campaign_id")
    currency = _snapshot_currency(file_meta)
    start = _date_value(manifest["request"]["start_date"], "request.start_date")
    end = _date_value(manifest["request"]["end_date"], "request.end_date")
    rows = []
    seen_dates: set[str] = set()
    for index, category in enumerate(categories, start=1):
        metric_date = _date_value(category, f"chart.categories[{index}]")
        if metric_date < start or metric_date > end:
            raise CleaningError("chart_date_out_of_range", f"campaign daily chart date is outside request: {metric_date}")
        if metric_date in seen_dates:
            raise CleaningError("record_key_duplicate", f"duplicate campaign daily date: {metric_date}")
        seen_dates.add(metric_date)
        raw_values = {name: values[index - 1] for name, values in by_name.items()}
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, index)
        row["currency"] = currency
        row.update({
            "campaign_id": campaign_id,
            "metric_date": metric_date,
            "cost": _decimal(raw_values["cost"], "chart.cost"),
            "impressions": None,
            "clicks": None,
            "ctr_official": None,
            "sku_orders": _integer(raw_values["onsite_roi2_shopping_sku"], "chart.onsite_roi2_shopping_sku"),
            "cost_per_order_official": _decimal(raw_values["cost_per_onsite_roi2_shopping_sku"], "chart.cost_per_onsite_roi2_shopping_sku"),
            "gross_revenue": _decimal(raw_values["onsite_roi2_shopping_value"], "chart.onsite_roi2_shopping_value"),
            "roi_official": _decimal(raw_values["onsite_roi2_shopping"], "chart.onsite_roi2_shopping"),
            "sns_opt_gross_revenue": _optional_decimal(raw_values.get("onsite_roi2_sns_opt_shopping_value"), "chart.onsite_roi2_sns_opt_shopping_value"),
            "sns_opt_roi_official": _optional_decimal(raw_values.get("onsite_roi2_sns_opt_shopping"), "chart.onsite_roi2_sns_opt_shopping"),
            "raw_series_json": _json_text(raw_values, "chart.series"),
        })
        _add_ad_calculations(row)
        rows.append(_finish(dataset, row, file_meta, index))
    return dataset["name"], rows, {
        "source_file": file_meta["path"], "source_rows_excluding_header": len(categories),
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"},
    }


def _parse_campaign_product_daily(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], response: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    records = response.get("records")
    if not isinstance(records, list):
        raise CleaningError("snapshot_shape_mismatch", "campaign product daily response lacks records")
    collection = snapshot.get("collection") or {}
    selected_campaign_ids = collection.get("selected_campaign_ids")
    metric_dates = collection.get("metric_dates")
    coverage = collection.get("unit_coverage")
    if collection.get("pagination_complete") is not True or not isinstance(selected_campaign_ids, list):
        raise CleaningError("pagination_incomplete", "campaign product daily campaign universe is incomplete")
    if not isinstance(metric_dates, list) or not metric_dates or not isinstance(coverage, list):
        raise CleaningError("coverage_contract_invalid", "campaign product daily coverage metadata is missing")
    planned = collection.get("planned_coverage_unit_count")
    attempted = collection.get("attempted_coverage_unit_count")
    completed = collection.get("completed_coverage_unit_count")
    reused = collection.get("reused_coverage_unit_count")
    if not all(isinstance(value, int) and value >= 0 for value in (planned, attempted, completed, reused)):
        raise CleaningError("coverage_contract_invalid", "campaign product daily coverage counts are invalid")
    if attempted + reused > planned or completed > attempted or completed != len(coverage):
        raise CleaningError("coverage_contract_invalid", "campaign product daily coverage counts do not reconcile")
    coverage_by_unit: dict[tuple[str, str], int] = {}
    for item in coverage:
        if not isinstance(item, dict):
            raise CleaningError("coverage_contract_invalid", "campaign product daily unit coverage is not an object")
        campaign_id = _require_campaign_id(item.get("campaign_id"), "unit_coverage.campaign_id")
        metric_date = _date_value(item.get("metric_date"), "unit_coverage.metric_date")
        official = item.get("official_total_count")
        collected = item.get("collected_count")
        if item.get("pagination_complete") is not True or not isinstance(official, int) or official < 0 or collected != official:
            raise CleaningError("pagination_count_mismatch", "campaign product daily unit pagination is incomplete")
        key = (campaign_id, metric_date)
        if key in coverage_by_unit:
            raise CleaningError("coverage_contract_invalid", "campaign product daily unit coverage is duplicated")
        coverage_by_unit[key] = official
    if collection.get("observed_record_count") != len(records):
        raise CleaningError("pagination_count_mismatch", "campaign product daily observed record count is inconsistent")
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    currency = _snapshot_currency(file_meta)
    start = _date_value(manifest["request"]["start_date"], "request.start_date")
    end = _date_value(manifest["request"]["end_date"], "request.end_date")
    rows = []
    seen: set[tuple[str, str, str]] = set()
    row_counts: dict[tuple[str, str], int] = {}
    for index, source in enumerate(records, start=1):
        if not isinstance(source, dict):
            raise CleaningError("snapshot_shape_mismatch", f"campaign product daily row is not an object: {index}")
        campaign_id = _require_campaign_id(source.get("campaign_id"), f"records[{index}].campaign_id")
        product_id = _require_campaign_id(source.get("product_id"), f"records[{index}].product_id")
        metric_date = _date_value(source.get("metric_date"), f"records[{index}].metric_date")
        if metric_date < start or metric_date > end or metric_date not in metric_dates:
            raise CleaningError("chart_date_out_of_range", f"campaign product daily date is outside request: {metric_date}")
        unit_key = (campaign_id, metric_date)
        if unit_key not in coverage_by_unit:
            raise CleaningError("coverage_contract_invalid", "campaign product daily row lacks unit coverage")
        key = (campaign_id, product_id, metric_date)
        if key in seen:
            raise CleaningError("record_key_duplicate", f"duplicate campaign product daily row: {campaign_id}/{product_id}/{metric_date}")
        seen.add(key)
        row_counts[unit_key] = row_counts.get(unit_key, 0) + 1
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, index)
        row["currency"] = _required_string(source.get("currency"), "records.currency")
        if row["currency"] != currency:
            raise CleaningError("currency_inconsistent", "campaign product daily row currency differs from Manifest evidence")
        row.update({
            "campaign_id": campaign_id,
            "campaign_name_observed": _optional_string(source.get("campaign_name")),
            "product_id": product_id,
            "product_name": _required_string(source.get("product_name"), "records.product_name"),
            "metric_date": metric_date,
            "sku_orders": _integer(source.get("sku_orders"), "records.sku_orders"),
            "gross_revenue": _decimal(source.get("gross_revenue"), "records.gross_revenue"),
            "cost": _decimal(source.get("cost"), "records.cost"),
            "cost_per_order_official": _decimal(source.get("cost_per_order_official"), "records.cost_per_order_official"),
            "roi_official": _decimal(source.get("roi_official"), "records.roi_official"),
            "raw_product_json": _json_text(source, "campaign_product_daily_record"),
        })
        _add_ad_calculations(row)
        rows.append(_finish(dataset, row, file_meta, index))
    if any(row_counts.get(key, 0) != official for key, official in coverage_by_unit.items()):
        raise CleaningError("pagination_count_mismatch", "campaign product daily rows do not conserve unit totals")
    return dataset["name"], rows, {
        "source_file": file_meta["path"], "source_rows_excluding_header": len(records),
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"},
    }


def _parse_change_log(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], response: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    data = response.get("data")
    source_rows = None
    if isinstance(data, dict):
        if snapshot.get("schema_version") == "seller_api_snapshot_v2":
            source_rows = data.get("records")
        else:
            source_rows = data.get("table")
            if source_rows is None:
                source_rows = data.get("logs")
        if source_rows is None:
            pagination = data.get("pagination")
            if isinstance(pagination, dict) and pagination.get("total_count") == 0:
                source_rows = []
    if not isinstance(data, dict) or not isinstance(source_rows, list):
        raise CleaningError("snapshot_shape_mismatch", "change log response lacks table or logs")
    if snapshot.get("schema_version") == "seller_api_snapshot_v2":
        _pagination_complete(
            snapshot, data, len(source_rows), Path(file_meta["path"]),
            collected_count_field="observed_record_count", validate_official_total=False,
        )
    else:
        _pagination_complete(snapshot, data, len(source_rows), Path(file_meta["path"]))
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    campaign_id = _require_campaign_id(file_meta.get("campaign_id") or (snapshot.get("identity") or {}).get("campaign_id"), "campaign_id")
    rows = []
    for index, source in enumerate(source_rows, start=1):
        if not isinstance(source, dict):
            raise CleaningError("snapshot_shape_mismatch", f"change log row is not an object: {index}")
        event_id = _required_string(str(source.get("id")) if source.get("id") is not None else None, f"table[{index}].id")
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, index)
        row.update({
            "campaign_id": campaign_id,
            "event_id": event_id,
            "event_time_raw": _required_string(str(source.get("opt_time")) if source.get("opt_time") is not None else None, f"table[{index}].opt_time"),
            "user": _optional_string(source.get("user")),
            "object_id": _optional_string(source.get("object_id")),
            "object_type": _optional_string(source.get("object_type")),
            "object_raw_type": _optional_string(source.get("object_raw_type")),
            "activity_details_json": _json_text(source.get("activity_details"), "activity_details"),
            "raw_event_json": _json_text(source, "change_log_row"),
        })
        rows.append(_finish(dataset, row, file_meta, index))
    return dataset["name"], rows, {
        "source_file": file_meta["path"], "source_rows_excluding_header": len(source_rows),
        "detail_rows": len(rows), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"},
    }


def _parse_recommendations(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], response: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    data = response.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise CleaningError("snapshot_shape_mismatch", "recommendation response lacks items list")
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    campaign_id = _require_campaign_id(file_meta.get("campaign_id") or (snapshot.get("identity") or {}).get("campaign_id"), "campaign_id")
    items = data["items"]
    rows = []
    raw_response = _json_text(response, "recommendation_response")
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise CleaningError("snapshot_shape_mismatch", f"recommendation item is not an object: {index}")
        recommendation_id = _required_string(str(item.get("id")) if item.get("id") is not None else None, f"items[{index}].id")
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, index)
        row.update({
            "campaign_id": campaign_id,
            "record_type": "item",
            "record_id": recommendation_id,
            "recommendation_name": _optional_string(item.get("name")),
            "item_type": _optional_string(item.get("item_type")),
            "apply_entity": _optional_string(item.get("apply_entity")),
            "content_json": _json_text(item.get("content"), "recommendation.content"),
            "extra_json": _json_text(item.get("extra"), "recommendation.extra"),
            "trace_info_json": _json_text(item.get("trace_info"), "recommendation.trace_info"),
            "summary_json": None,
            "gmv_diagnosis_data_json": None,
            "diagnosis_type": None,
            "attribution_type": None,
            "rec_category_list_json": None,
            "recommendation_count": str(len(items)),
            "raw_response_json": raw_response,
        })
        rows.append(_finish(dataset, row, file_meta, index))
    summary = data.get("summary")
    if summary is not None:
        row_number = len(rows) + 1
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, row_number)
        row.update({
            "campaign_id": campaign_id,
            "record_type": "summary",
            "record_id": "summary",
            "recommendation_name": None,
            "item_type": None,
            "apply_entity": None,
            "content_json": None,
            "extra_json": None,
            "trace_info_json": None,
            "summary_json": _json_text(summary.get("summary") if isinstance(summary, dict) else summary, "recommendation.summary"),
            "gmv_diagnosis_data_json": _json_text(summary.get("gmv_diagnosis_data") if isinstance(summary, dict) else None, "recommendation.gmv_diagnosis_data"),
            "diagnosis_type": _optional_string(summary.get("diagnosis_type") if isinstance(summary, dict) else None),
            "attribution_type": _optional_string(summary.get("attribution_type") if isinstance(summary, dict) else None),
            "rec_category_list_json": _json_text(summary.get("rec_category_list") if isinstance(summary, dict) else None, "recommendation.rec_category_list"),
            "recommendation_count": str(len(items)),
            "raw_response_json": raw_response,
        })
        rows.append(_finish(dataset, row, file_meta, row_number))
    if not rows:
        row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, 1)
        row.update({
            "campaign_id": campaign_id, "record_type": "empty", "record_id": "empty",
            "recommendation_name": None, "item_type": None, "apply_entity": None,
            "content_json": None, "extra_json": None, "trace_info_json": None,
            "summary_json": None, "gmv_diagnosis_data_json": None, "diagnosis_type": None,
            "attribution_type": None, "rec_category_list_json": None, "recommendation_count": "0",
            "raw_response_json": raw_response,
        })
        rows.append(_finish(dataset, row, file_meta, 1))
    return dataset["name"], rows, {
        "source_file": file_meta["path"], "source_rows_excluding_header": len(items),
        "detail_rows": len(items), "summary_rows": 1 if summary is not None else 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"},
    }


def _bundle_response(snapshot: dict[str, Any], key: str, path: Path) -> dict[str, Any]:
    bundle = snapshot.get("responses")
    if not isinstance(bundle, dict):
        response = snapshot.get("response")
        bundle = response.get("responses") if isinstance(response, dict) else None
    if not isinstance(bundle, dict) or not isinstance(bundle.get(key), dict):
        raise CleaningError("snapshot_response_missing", f"upgrade response is missing {key}: {path}")
    value = bundle[key]
    if value.get("code") != 0:
        raise CleaningError("api_response_error", f"upgrade response code is not zero for {key}: {path}")
    return value


def _parse_upgrade_sessions(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str,
    snapshot: dict[str, Any], captured_at: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    if snapshot.get("schema_version") == "seller_api_snapshot_v2":
        outer = snapshot.get("response") or {}
        data = outer.get("data") if isinstance(outer.get("data"), dict) else {}
        session_query = data.get("session_query") if isinstance(data.get("session_query"), dict) else {}
        summary_response = data.get("optimization_summary") if isinstance(data.get("optimization_summary"), dict) else {}
        if session_query.get("code") != 0 or summary_response.get("code") != 0:
            raise CleaningError("api_response_error", f"upgrade response code is not zero: {path}")
        query_data = session_query.get("data") if isinstance(session_query.get("data"), dict) else {}
        summary_data = summary_response.get("data") if isinstance(summary_response.get("data"), dict) else {}
        current = query_data.get("session_list") or []
        history = data.get("session_records") or []
        list_data = {"records": history}
    else:
        session_query = _bundle_response(snapshot, "session_query", path)
        summary_response = _bundle_response(snapshot, "optimization_summary", path)
        list_response = _bundle_response(snapshot, "session_list", path)
        query_data = session_query.get("data") if isinstance(session_query.get("data"), dict) else {}
        summary_data = summary_response.get("data") if isinstance(summary_response.get("data"), dict) else {}
        list_data = list_response.get("data") if isinstance(list_response.get("data"), dict) else {}
        current = query_data.get("table") or query_data.get("current") or []
        history = list_data.get("table") or []
    if not isinstance(current, list) or not isinstance(history, list):
        raise CleaningError("snapshot_shape_mismatch", f"upgrade session tables are invalid: {path}")
    if snapshot.get("schema_version") == "seller_api_snapshot_v2":
        collection = snapshot.get("collection") or {}
        pages = data.get("session_pages")
        if collection.get("pagination_complete") is not True or not isinstance(pages, list):
            raise CleaningError("pagination_incomplete", f"upgrade session pagination is incomplete: {path}")
        totals = []
        for page in pages:
            pagination = ((page.get("data") or {}).get("pagination") if isinstance(page, dict) else None)
            if not isinstance(pagination, dict) or not isinstance(pagination.get("total_count"), int):
                raise CleaningError("pagination_missing", f"upgrade session pagination is missing: {path}")
            totals.append(pagination["total_count"])
        if totals and (len(set(totals)) != 1 or totals[0] != len(history)):
            raise CleaningError("pagination_count_mismatch", f"upgrade history count differs from official pagination: {path}")
    else:
        _pagination_complete(snapshot, list_data, len(history), path)
    dataset = _dataset(model, REPORT_TO_DATASET[report_id])
    campaign_id = _require_campaign_id(file_meta.get("campaign_id") or (snapshot.get("identity") or {}).get("campaign_id"), "campaign_id")
    currency = _snapshot_currency(file_meta) if snapshot.get("schema_version") == "seller_api_snapshot_v2" else None
    rows = []
    for index, source in enumerate(current, start=1):
        if not isinstance(source, dict):
            raise CleaningError("snapshot_shape_mismatch", f"current session row is not an object: {index}")
        info = source.get("session_info") if isinstance(source.get("session_info"), dict) else source
        session_id = _optional_string(source.get("id") or source.get("gmv_max_session_id") or info.get("session_id"))
        if session_id is None:
            raise CleaningError("required_identity_missing", f"current session ID is missing: {index}")
        row = _upgrade_row(manifest, report_id, file_meta, batch_id, captured_at, campaign_id, "current", session_id, source, info)
        row["currency"] = currency
        _add_ad_calculations(row)
        rows.append(_finish(dataset, row, file_meta, index))
    for index, source in enumerate(history, start=len(rows) + 1):
        if not isinstance(source, dict):
            raise CleaningError("snapshot_shape_mismatch", f"historical session row is not an object: {index}")
        session_id = _optional_string(source.get("gmv_max_session_id") or source.get("id"))
        if session_id is None:
            raise CleaningError("required_identity_missing", f"historical session ID is missing: {index}")
        row = _upgrade_row(manifest, report_id, file_meta, batch_id, captured_at, campaign_id, "historical", session_id, source, source.get("session_info"))
        row["currency"] = currency
        _add_ad_calculations(row)
        rows.append(_finish(dataset, row, file_meta, index))
    summary_row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, len(rows) + 1)
    summary_row.update({
        "campaign_id": campaign_id, "record_type": "summary", "session_id": "summary",
        "budget": _optional_decimal(summary_data.get("active_session_total_budget"), "active_session_total_budget"),
        "schedule_start_time_raw": None, "schedule_end_time_raw": None, "schedule_type_raw": None,
        "session_type_raw": None, "item_id": None, "item_id_list_json": None,
        "item_budget_allocation_mode_raw": None, "session_status_raw": None, "session_create_time_raw": None,
        "gmv_max_bid_type_raw": None, "mixed_real_cost": None, "sku_orders": None,
        "gross_revenue": None, "cost_per_order_official": None,
        "summary_count": _optional_integer(summary_data.get("count"), "summary.count"),
        "creative_nobid_count": _optional_integer(summary_data.get("creative_nobid_count"), "summary.creative_nobid_count"),
        "session_count": _optional_integer(summary_data.get("session_count"), "summary.session_count"),
        "has_created_session": _optional_string(summary_data.get("has_created_session")),
        "active_session_count": _optional_integer(summary_data.get("active_session_count"), "summary.active_session_count"),
        "active_session_total_budget": _optional_decimal(summary_data.get("active_session_total_budget"), "summary.active_session_total_budget"),
        "raw_session_json": _json_text({"summary": summary_data}, "summary"),
    })
    summary_row["currency"] = currency
    _add_ad_calculations(summary_row)
    rows.append(_finish(dataset, summary_row, file_meta, len(rows) + 1))
    return dataset["name"], rows, {
        "source_file": file_meta["path"], "source_rows_excluding_header": len(current) + len(history),
        "detail_rows": len(current) + len(history), "summary_rows": 1, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"},
    }


def _upgrade_row(
    manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], batch_id: str, captured_at: str,
    campaign_id: str, record_type: str, session_id: str, source: dict[str, Any], info: Any,
) -> dict[str, Any]:
    info = info if isinstance(info, dict) else {}
    row = _base_snapshot_row(manifest, report_id, file_meta, batch_id, captured_at, 1)
    row.update({
        "campaign_id": campaign_id, "record_type": record_type, "session_id": session_id,
        "budget": _optional_decimal(source.get("budget") or info.get("budget"), "session.budget"),
        "schedule_start_time_raw": _optional_string(source.get("schedule_start_time") or info.get("start_time")),
        "schedule_end_time_raw": _optional_string(source.get("schedule_end_time") or info.get("end_time")),
        "schedule_type_raw": _optional_string(source.get("schedule_type") or info.get("schedule_type")),
        "session_type_raw": _optional_string(source.get("session_type")),
        "item_id": _optional_string(source.get("item_id")),
        "item_id_list_json": _json_text(source.get("item_id_list"), "session.item_id_list"),
        "item_budget_allocation_mode_raw": _optional_string(source.get("item_budget_allocation_mode")),
        "session_status_raw": _optional_string(source.get("session_status") or info.get("status")),
        "session_create_time_raw": _optional_string(source.get("session_create_time")),
        "gmv_max_bid_type_raw": _optional_string(source.get("gmv_max_bid_type")),
        "mixed_real_cost": _optional_decimal(source.get("mixed_real_cost"), "session.mixed_real_cost"),
        "sku_orders": _optional_integer(source.get("onsite_roi2_shopping_sku"), "session.onsite_roi2_shopping_sku"),
        "gross_revenue": _optional_decimal(source.get("onsite_roi2_shopping_value"), "session.onsite_roi2_shopping_value"),
        "cost_per_order_official": _optional_decimal(source.get("mixed_real_cost_per_onsite_roi2_shopping_sku"), "session.mixed_real_cost_per_onsite_roi2_shopping_sku"),
        "summary_count": None, "creative_nobid_count": None, "session_count": None,
        "has_created_session": None, "active_session_count": None, "active_session_total_budget": None,
        "raw_session_json": _json_text(source, "session"),
    })
    return row


def _parse_snapshot_file(
    manifest: dict[str, Any], report_id: str, report: dict[str, Any], file_meta: dict[str, Any], model: dict[str, Any],
    batch_id: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    snapshot = _read_snapshot(path)
    if snapshot.get("schema_version") == "seller_api_snapshot_v2":
        accepted_sources = {SOURCE_IDS_V2.get(report_id), SOURCE_IDS_V3.get(report_id)} - {None}
    else:
        accepted_sources = {SOURCE_IDS.get(report_id)} - {None}
    if snapshot.get("source_id") not in accepted_sources or file_meta.get("source_id") != snapshot.get("source_id"):
        raise CleaningError("snapshot_source_mismatch", f"snapshot source does not match report: {path}")
    captured_at = _captured(snapshot, file_meta, path)
    response = _response(snapshot, path)
    if report_id == "gmvmax_campaign_hourly_performance":
        return _parse_campaign_hourly(manifest, report_id, file_meta, model, batch_id, snapshot, response, captured_at)
    if report_id == "gmvmax_campaign_current_configuration_snapshot":
        return _parse_configuration(manifest, report_id, file_meta, model, batch_id, snapshot, response, captured_at)
    if report_id == "gmvmax_campaign_performance_interval":
        return _parse_performance_interval(manifest, report_id, file_meta, model, batch_id, snapshot, response, captured_at)
    if report_id == "gmvmax_campaign_daily_performance":
        return _parse_daily(manifest, report_id, file_meta, model, batch_id, snapshot, response, captured_at)
    if report_id == "gmvmax_campaign_product_daily_performance":
        return _parse_campaign_product_daily(manifest, report_id, file_meta, model, batch_id, snapshot, response, captured_at)
    if report_id == "gmvmax_campaign_change_log":
        return _parse_change_log(manifest, report_id, file_meta, model, batch_id, snapshot, response, captured_at)
    if report_id == "gmvmax_campaign_recommendation_snapshot":
        return _parse_recommendations(manifest, report_id, file_meta, model, batch_id, snapshot, response, captured_at)
    if report_id == "gmvmax_campaign_upgrade_session_snapshot":
        return _parse_upgrade_sessions(manifest, report_id, file_meta, model, batch_id, snapshot, captured_at)
    raise CleaningError("unsupported_report", f"unsupported API snapshot report: {report_id}")
