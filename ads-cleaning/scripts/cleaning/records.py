"""Dataset resolution, stable keys, hashes, and common record fields."""
from __future__ import annotations
import hashlib
import json
import unicodedata
from decimal import Decimal
from typing import Any
from .contracts import _source_header
from .conversion import _optional_string, _required_string
from .errors import CleaningError

CLEANING_VERSION = "2026-08-14.2"


def _dataset_for(report_id: str, header: list[str], model: dict[str, Any]) -> dict[str, Any]:
    candidates = [item for item in model["datasets"] if item["report_id"] == report_id]
    if report_id == "gmvmax_campaign_overview":
        candidates = [item for item in candidates if item.get("source_time_header") == header[0]]
    if len(candidates) != 1:
        raise CleaningError("dataset_not_resolved", f"cannot resolve dataset for {report_id} and first header {header[0]!r}")
    return candidates[0]


def _expected_headers(kind: str, baseline: dict[str, Any]) -> list[str]:
    try:
        return baseline["families"][kind]
    except KeyError as exc:
        raise CleaningError("schema_baseline_missing", f"header baseline missing: {kind}") from exc


def _kind(report_id: str, first_header: str) -> str:
    if report_id == "gmvmax_campaign_overview":
        return {"按天": "daily", "时间": "hourly"}.get(first_header, "unknown")
    if report_id == "gmvmax_campaign_product_performance":
        return "campaign_product"
    if report_id == "shop_creative_hub_video":
        return "creative"
    if report_id in {"gmvmax_campaign_product_creative_performance", "gmvmax_campaign_product_creative_daily_performance"}:
        return "campaign_product_creative"
    if report_id == "inventory_snapshot":
        return "inventory"
    if report_id in {"product_analytics_performance", "shop_product_daily_performance"}:
        return "product"
    if report_id == "manage_orders_csv":
        return "orders"
    if report_id == "returns_refunds_snapshot":
        return "returns_refunds"
    if report_id == "fulfillment_performance_snapshot":
        return "fulfillment"
    if report_id == "affiliate_center_performance":
        return "affiliate"
    if report_id == "product_ratings_review_list":
        return "ratings"
    if report_id == "shop_promotion_performance":
        return "promotion"
    if report_id == "shop_health_snapshot":
        return "health"
    return "unknown"


def _content_hash(dataset: str, row: dict[str, Any], fields: list[str]) -> str:
    payload = ["tiktok-cleaning-content-v1", dataset, [[name, row.get(name)] for name in fields]]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _source_row_key(file_hash: str, sheet: str, row_number: int) -> str:
    payload = ["tiktok-cleaning-source-row-v1", file_hash, unicodedata.normalize("NFC", sheet), row_number]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _canonical_row_hash(row: tuple[Any, ...]) -> str:
    payload = json.dumps(list(row), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _calculated_ratio(numerator: str, denominator: str) -> str | None:
    divisor = Decimal(denominator)
    if divisor == 0:
        return None
    return format((Decimal(numerator) / divisor).quantize(Decimal("0.000001")), "f")


def _add_ad_calculations(row: dict[str, Any]) -> None:
    required = {"cost", "sku_orders", "gross_revenue"}
    if not required.issubset(row):
        return
    row["revenue_per_sku_order_calculated"] = _calculated_ratio(row["gross_revenue"], row["sku_orders"])
    if {"impressions", "clicks"}.issubset(row) and row["impressions"] is not None and row["clicks"] is not None:
        impressions = Decimal(row["impressions"])
        row["ctr_calculated"] = None if impressions == 0 else format(
            ((Decimal(row["clicks"]) * Decimal("100")) / impressions).quantize(Decimal("0.000001")), "f"
        )
    if {"product_ad_impressions", "product_ad_clicks"}.issubset(row):
        row["cpc_calculated"] = _calculated_ratio(row["cost"], row["product_ad_clicks"])
        impressions = Decimal(row["product_ad_impressions"])
        row["cpm_calculated"] = None if impressions == 0 else format(((Decimal(row["cost"]) * Decimal("1000")) / impressions).quantize(Decimal("0.000001")), "f")


def _base_row(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], sheet: str, row_number: int, batch_id: str) -> dict[str, Any]:
    request = manifest["request"]
    shop = manifest["shop"]
    report = next(item for item in manifest["reports"] if item["report_id"] == report_id)
    advertiser = (manifest.get("selected_advertiser") or {}) if report.get("owner_type") == "advertiser" else {}
    return {
        "report_id": report_id,
        "provider_id": _required_string(shop["provider_id"], "shop.provider_id"),
        "shop_alias": _required_string(shop["shop_alias"], "shop.shop_alias"),
        "shop_id": _required_string(shop["seller_id"], "shop.seller_id"),
        "shop_region": _required_string(shop["shop_region"], "shop.shop_region"),
        "business_timezone": _required_string(shop["business_timezone"], "shop.business_timezone"),
        "advertiser_id": _optional_string(advertiser.get("advertiser_id")),
        "advertiser_name": _optional_string(advertiser.get("advertiser_name")),
        "requested_start_date": request["start_date"],
        "requested_end_date": request["end_date"],
        "export_batch_id": manifest["export_batch_id"],
        "logical_export_job_id": manifest.get("logical_export_job_id"),
        "work_unit_id": None,
        "coverage_unit_key": None,
        "authoritative_attempt_id": None,
        "batch_status": manifest.get("batch_status"),
        "logical_job_status": None,
        "report_campaign_universe_policy": report.get("report_campaign_universe_policy"),
        "universe_completeness_status": None,
        "cleaning_batch_id": batch_id,
        "cleaning_version": CLEANING_VERSION,
        "source_file_path": file_meta.get("lineage_path", file_meta["path"]),
        "source_file_hash": file_meta["sha256"],
        "source_sheet": unicodedata.normalize("NFC", sheet),
        "source_row_number": row_number,
        "currency_scope": _optional_string(report.get("currency_scope")),
    }
