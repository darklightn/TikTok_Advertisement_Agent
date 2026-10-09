"""Parsers shared by standard single-header XLSX report families."""
from __future__ import annotations
from decimal import Decimal
import hashlib
import json
from itertools import zip_longest
from pathlib import Path
from typing import Any
from record_key import record_key
from xlsx_reader import XlsxReadError, read_first_sheet
from ..conversion import _convert, _date_value, _decimal, _integer, _money, _optional_string, _required_string, _utc_datetime_value
from ..errors import CleaningError
from ..records import _add_ad_calculations, _base_row, _canonical_row_hash, _content_hash, _dataset_for, _expected_headers, _kind, _source_header, _source_row_key
from .product import _parse_product_file
from .product_daily_api import _parse_product_daily_api
from .orders import _parse_order_file
from .ratings import _parse_ratings_file
from .promotion import _parse_promotion_file
from .health import _parse_health_file
from .snapshots import SNAPSHOT_REPORT_IDS, _parse_snapshot_file
from .shop_sources import SOURCE_IDS as SHOP_SOURCE_IDS, _parse_shop_source
from .advertiser_account import REPORT_ID as ADVERTISER_ACCOUNT_REPORT_ID, parse_advertiser_account


AFFILIATE_HEADER_VERSIONS = {
    "affiliate_daily_average_v1": "affiliate_daily_average_v1",
    "affiliate_interval_total_v2": "affiliate_interval_total_v2",
}


def _header_sha256(header: list[str]) -> str:
    canonical = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _header_differences(expected: list[str], actual: list[str]) -> list[dict[str, Any]]:
    differences = []
    for column, (expected_value, actual_value) in enumerate(zip_longest(expected, actual), start=1):
        if expected_value != actual_value:
            differences.append({"column": column, "expected": expected_value, "actual": actual_value})
    return differences


def _affiliate_header_version(header: list[str], baseline: dict[str, Any], file_meta: dict[str, Any]) -> str:
    candidates = {
        version: _expected_headers(family, baseline)
        for version, family in AFFILIATE_HEADER_VERSIONS.items()
    }
    for version, expected in candidates.items():
        if header == expected:
            return version
    compared_version, expected = min(
        candidates.items(),
        key=lambda item: (len(_header_differences(item[1], header)), item[0]),
    )
    artifact = file_meta.get("_artifact") or {}
    details = {
        "report_id": "affiliate_center_performance",
        "code": "report_schema_version_unsupported",
        "source_artifact_id": artifact.get("artifact_id"),
        "source_file_relative_path": file_meta.get("lineage_path"),
        "observed_header_sha256": _header_sha256(header),
        "compared_version": compared_version,
        "differences": _header_differences(expected, header),
    }
    raise CleaningError(
        "report_schema_version_unsupported",
        "affiliate_center_performance source header does not match a verified version",
        details,
    )


def _days_of_supply_calculated(available_stock: str, sales_30d: str) -> str | None:
    sales = Decimal(sales_30d)
    if sales == 0:
        return None
    return format((Decimal(available_stock) * Decimal("30") / sales).quantize(Decimal("0.000001")), "f")


def _parse_file(manifest: dict[str, Any], report_id: str, report: dict[str, Any], file_meta: dict[str, Any], model: dict[str, Any], baseline: dict[str, Any], batch_id: str, product_columns: list[tuple[str, str]]) -> tuple[str, list[dict[str, Any]], dict[str, Any]] | list[tuple[str, list[dict[str, Any]], dict[str, Any]]]:
    if file_meta.get("file_kind") == "api_snapshot" and report_id == "shop_product_daily_performance":
        return _parse_product_daily_api(manifest, report_id, file_meta, model, batch_id)
    if file_meta.get("file_kind") == "api_snapshot" and report_id == ADVERTISER_ACCOUNT_REPORT_ID:
        return parse_advertiser_account(manifest, report_id, report, file_meta, model, batch_id)
    if file_meta.get("file_kind") == "api_snapshot" and report_id in SNAPSHOT_REPORT_IDS:
        return _parse_snapshot_file(manifest, report_id, report, file_meta, model, batch_id)
    if file_meta.get("file_kind") == "api_snapshot" and report_id in SHOP_SOURCE_IDS:
        return _parse_shop_source(manifest, report_id, file_meta, model, batch_id)
    if report_id == "shop_product_daily_performance":
        raise CleaningError("source_file_kind_invalid", "daily product source requires api_snapshot")
    if report_id == "product_analytics_performance":
        return _parse_product_file(manifest, report_id, file_meta, model, baseline, batch_id, product_columns)
    if report_id == "manage_orders_csv":
        return _parse_order_file(manifest, report, file_meta, model, baseline, batch_id)
    if report_id == "product_ratings_review_list":
        return _parse_ratings_file(manifest, report_id, file_meta, model, baseline, batch_id)
    if report_id == "shop_promotion_performance":
        return _parse_promotion_file(manifest, report_id, file_meta, model, baseline, batch_id)
    if report_id == "shop_health_snapshot":
        return _parse_health_file(manifest, report_id, report, file_meta, model, baseline, batch_id)
    path = Path(file_meta["path"])
    try:
        sheet_name, physical_rows = read_first_sheet(path)
    except XlsxReadError as exc:
        raise CleaningError(exc.code, f"{exc}: {path}") from exc
    if not physical_rows:
        raise CleaningError("source_empty_without_header", f"workbook has no header: {path}")
    header = ["" if value is None else str(value) for value in physical_rows[0]]
    kind = _kind(report_id, header[0] if header else "")
    if kind == "unknown":
        raise CleaningError("unknown_header", f"unknown source header in {path}")
    header_kind = kind
    affiliate_version = None
    if report_id == "affiliate_center_performance":
        affiliate_version = _affiliate_header_version(header, baseline, file_meta)
        header_kind = AFFILIATE_HEADER_VERSIONS[affiliate_version]
    expected = _expected_headers(header_kind, baseline)
    if header != expected:
        raise CleaningError("header_mismatch", f"source header differs from baseline: {path}")
    dataset = _dataset_for(report_id, header, model)
    field_by_header = {_source_header(field): field for field in dataset["fields"] if _source_header(field)}
    if affiliate_version == "affiliate_interval_total_v2":
        interval_fields = {field["name"]: field for field in dataset["fields"]}
        field_by_header.update({
            "已添加到商品橱窗的商品数": interval_fields["product_showcase_additions"],
            "客户数": interval_fields["customers"],
            "商品销量": interval_fields["product_units_sold"],
        })
    rows: list[dict[str, Any]] = []
    summary_rows: list[tuple[int, tuple[Any, ...]]] = []
    definition_rows: list[tuple[int, tuple[Any, ...]]] = []
    blank_rows = 0
    for row_number, values in enumerate(physical_rows[1:], start=2):
        if len(values) > len(header):
            raise CleaningError("row_width_mismatch", f"row has cells beyond the source header: {path}:{row_number}")
        values = values + (None,) * (len(header) - len(values))
        if all(value is None or str(value).strip() == "" for value in values):
            blank_rows += 1
            continue
        if any(isinstance(value, str) and value.startswith("=") for value in values):
            raise CleaningError("formula_cell", f"formula cell is not accepted: {path}:{row_number}")
        if report_id == "affiliate_center_performance" and (values[0] is None or str(values[0]).strip() == ""):
            definition_rows.append((row_number, values))
            continue
        if str(values[0]).strip() == "-":
            summary_rows.append((row_number, values))
            continue
        parsed = _base_row(manifest, report_id, file_meta, sheet_name, row_number, batch_id)
        currencies: set[str] = set()
        for column, value in zip(header, values):
            if column in {"币种", "Currency"}:
                parsed["currency"] = _required_string(value, "currency")
            else:
                field = field_by_header[column]
                if report_id in {"gmvmax_campaign_product_creative_performance", "gmvmax_campaign_product_creative_daily_performance"} and column == "Post ID" and str(value).strip() == "N/A":
                    parsed[field["name"]] = None
                    if report_id == "gmvmax_campaign_product_creative_daily_performance":
                        parsed["post_id_raw"] = "N/A"
                elif field["type"] == "money":
                    parsed[field["name"]], currency = _money(value, field["name"])
                    currencies.add(currency)
                else:
                    parsed[field["name"]] = _convert(value, field)
        if report_id == "gmvmax_campaign_product_performance":
            parsed["campaign_id"] = _required_string(file_meta.get("campaign_id"), "campaign_id")
            parsed["campaign_name_observed"] = _optional_string(file_meta.get("campaign_name_observed"))
        if report_id in {"gmvmax_campaign_product_creative_performance", "gmvmax_campaign_product_creative_daily_performance"}:
            parsed["campaign_id"] = _required_string(file_meta.get("campaign_id"), "campaign_id")
            parsed["campaign_name_observed"] = _optional_string(file_meta.get("campaign_name_observed"))
            parsed["product_id"] = _required_string(file_meta.get("product_id"), "product_id")
            parsed["product_name_observed"] = _optional_string(file_meta.get("product_name_observed"))
        if report_id == "gmvmax_campaign_product_creative_daily_performance":
            parsed["metric_date"] = _date_value(file_meta.get("metric_date"), "metric_date")
            if parsed.get("post_id_raw") is None:
                parsed["post_id_raw"] = _required_string(parsed.get("post_id"), "post_id")
        if report_id in {"inventory_snapshot", "returns_refunds_snapshot", "fulfillment_performance_snapshot"}:
            manifest_captured_at = _utc_datetime_value(report["captured_at"], "report.captured_at")
            if _utc_datetime_value(parsed["captured_at"], "captured_at") != manifest_captured_at:
                raise CleaningError("captured_at_mismatch", f"row capture time differs from Manifest: {path}:{row_number}")
        if report_id == "inventory_snapshot":
            parsed["days_of_supply_calculated"] = _days_of_supply_calculated(parsed["available_stock"], parsed["sales_30d"])
        if report_id == "returns_refunds_snapshot":
            if len(currencies) != 1:
                raise CleaningError("currency_inconsistent", f"returns/refunds row must contain one currency: {path}:{row_number}")
            parsed["currency"] = currencies.pop()
        if report_id == "affiliate_center_performance":
            if len(currencies) != 1:
                raise CleaningError("currency_inconsistent", f"affiliate row must contain one currency: {path}:{row_number}")
            parsed["currency"] = currencies.pop()
        _add_ad_calculations(parsed)
        key_values = [parsed.get(name) for name in dataset["record_key_components"]]
        parsed["record_key"] = record_key(dataset["name"], key_values)
        parsed["source_row_key"] = _source_row_key(file_meta["sha256"], sheet_name, row_number)
        parsed["record_content_hash"] = _content_hash(dataset["name"], parsed, dataset["content_fields"])
        rows.append(parsed)
    if report_id == "gmvmax_campaign_overview":
        if rows and len(summary_rows) != 1:
            raise CleaningError("summary_count_invalid", f"non-empty overview requires one summary row: {path}")
        if summary_rows and summary_rows[0][0] != len(physical_rows) - blank_rows:
            raise CleaningError("summary_not_last", f"overview summary must be the last nonblank row: {path}")
    elif summary_rows:
        raise CleaningError("unexpected_summary", f"summary row is not allowed: {path}")
    record_keys = [row["record_key"] for row in rows]
    if len(record_keys) != len(set(record_keys)):
        raise CleaningError("record_key_duplicate", f"duplicate record key in source file: {path}")
    if report_id == "fulfillment_performance_snapshot":
        expected_metrics = {
            ("平均履约时间", "待发货–已签收时间"), ("平均履约时间", "待发货–待揽收时间"),
            ("平均履约时间", "待揽收–运输中时间"), ("平均履约时间", "运输中–已签收时间"),
            ("履约表现指标", "延迟发货率"), ("履约表现指标", "商责取消率"),
            ("履约表现指标", "快速发货率"), ("履约提醒", "24小时内发货"),
            ("履约提醒", "24小时内自动取消"), ("履约提醒", "备货超时"),
        }
        observed_metrics = {(row["category"], row["metric_name"]) for row in rows}
        if observed_metrics != expected_metrics or len(rows) != len(expected_metrics):
            raise CleaningError("fulfillment_metric_set_mismatch", f"fulfillment metric set differs from contract: {path}")
        for row in rows:
            if row["category"] == "履约表现指标" and (row["assessment_start"] is None or row["assessment_end"] is None or row["numerator"] is None or row["denominator"] is None):
                raise CleaningError("fulfillment_assessment_incomplete", f"fulfillment assessment fields are incomplete: {path}:{row['source_row_number']}")
    if report_id == "affiliate_center_performance":
        if len(definition_rows) != 1 or definition_rows[0][0] != 2 or any(value is None or str(value).strip() == "" for value in definition_rows[0][1][1:]):
            raise CleaningError("affiliate_definition_row_invalid", f"affiliate definition row differs from contract: {path}")
        if len({row["currency"] for row in rows}) != 1:
            raise CleaningError("currency_inconsistent", f"affiliate file must contain one currency: {path}")
    if report_id == "gmvmax_campaign_product_creative_daily_performance" and len(rows) != file_meta.get("official_total_count"):
        raise CleaningError("official_total_count_mismatch", f"daily creative rows differ from official total: {path}")
    qa = {
        "source_file": str(path), "source_rows_excluding_header": len(physical_rows) - 1,
        "detail_rows": len(rows), "summary_rows": len(summary_rows), "blank_rows": blank_rows,
        "rejected_rows": 0, "row_conservation": len(physical_rows) - 1 == len(rows) + len(summary_rows) + len(definition_rows) + blank_rows,
        "summary_reconciliation": _reconcile_summary(rows, summary_rows, header, report_id, model),
    }
    if report_id == "affiliate_center_performance":
        qa["header_version"] = affiliate_version
        qa["header_sha256"] = _header_sha256(header)
        qa["definition_rows"] = len(definition_rows)
        qa["definition_row_sha256"] = _canonical_row_hash(definition_rows[0][1])
    return dataset["name"], rows, qa


def _tolerance(model: dict[str, Any], report_id: str, currency: str, field: str) -> Decimal:
    profiles = model["qa_contract"]["currency_tolerance_policy"]["profiles"]
    for profile in profiles:
        if profile["report_id"] == report_id and profile["currency"] == currency:
            if field in profile["field_absolute_tolerance"]:
                return Decimal(profile["field_absolute_tolerance"][field])
    raise CleaningError("currency_tolerance_unapproved", f"no approved tolerance for {report_id}/{currency}/{field}")


def _reconcile_summary(rows: list[dict[str, Any]], summaries: list[tuple[int, tuple[Any, ...]]], header: list[str], report_id: str, model: dict[str, Any]) -> dict[str, Any]:
    if report_id != "gmvmax_campaign_overview" or not summaries:
        return {"status": "not_applicable" if report_id != "gmvmax_campaign_overview" else "empty_source_no_summary"}
    values = dict(zip(header, summaries[0][1]))
    currency = _required_string(values.get("币种"), "summary.currency")
    mapping = {"cost": "Cost", "sku_orders": "SKU orders (Current shop)", "gross_revenue": "Gross revenue (Current shop)"}
    checks = []
    for field, source_header in mapping.items():
        actual = sum(Decimal(row[field]) for row in rows)
        expected = Decimal(_integer(values[source_header], field)) if field == "sku_orders" else Decimal(_decimal(values[source_header], field))
        tolerance = Decimal("0") if field == "sku_orders" else _tolerance(model, report_id, currency, field)
        difference = abs(actual - expected)
        checks.append({"field": field, "detail_sum": format(actual, "f"), "official_summary": format(expected, "f"), "absolute_difference": format(difference, "f"), "tolerance": format(tolerance, "f"), "passed": difference <= tolerance})
    if not all(item["passed"] for item in checks):
        raise CleaningError("summary_reconciliation_failed", f"official summary differs for {report_id}/{currency}")
    return {"status": "passed", "currency": currency, "checks": checks, "official_ratios_preserved": True}
