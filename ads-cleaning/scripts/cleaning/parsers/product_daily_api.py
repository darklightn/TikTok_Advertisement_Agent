"""Parser for the verified Seller Center daily product-list API envelope."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from record_key import record_key
from ..errors import CleaningError
from ..records import _base_row, _content_hash, _dataset_for, _source_row_key


GMV_TIERS = {
    0: "GMV 和成交件数 = 0",
    1: "商品销量 ≥ 1",
    2: "GMV≥ 250 或商品销量 ≥ 3",
    3: "GMV≥ 3.5K 或商品销量 ≥ 100",
    5: "GMV≥ 30K 或商品销量 ≥ 1K",
}
PRODUCT_STATUSES = {1: "可售"}


def _money(value: Any, field: str) -> str:
    if not isinstance(value, dict) or value.get("currency_code") != "PHP" or value.get("amount") is None:
        raise CleaningError("product_api_money_invalid", f"invalid PHP money object: {field}")
    return str(value["amount"])


def _scalar(value: Any, field: str) -> str:
    if value is None or isinstance(value, (dict, list)):
        raise CleaningError("product_api_value_invalid", f"missing scalar: {field}")
    return str(value)


def _common(stats: dict[str, Any], prefix: str) -> dict[str, str]:
    return {
        f"{prefix}_gmv": _money(stats["gmv"], f"{prefix}.gmv"),
        f"{prefix}_orders": _scalar(stats["orders"], f"{prefix}.orders"),
        f"{prefix}_sku_orders": _scalar(stats["sku_orders"], f"{prefix}.sku_orders"),
        f"{prefix}_units_sold": _scalar(stats["items_sold"], f"{prefix}.items_sold"),
        f"{prefix}_estimated_customers": _scalar(stats["customers"], f"{prefix}.customers"),
        f"{prefix}_average_order_value": _money(stats["aov_sku"], f"{prefix}.aov_sku"),
        f"{prefix}_impressions": _scalar(stats["product_impression_pv"], f"{prefix}.product_impression_pv"),
        f"{prefix}_clicks": _scalar(stats["product_click_pv"], f"{prefix}.product_click_pv"),
        f"{prefix}_click_rate_official": _scalar(stats["product_ctr_pv"], f"{prefix}.product_ctr_pv"),
        f"{prefix}_add_to_cart": _scalar(stats["add_to_cart_cnt_pv"], f"{prefix}.add_to_cart_cnt_pv"),
        f"{prefix}_add_to_cart_rate_official": _scalar(stats["add_to_cart_rate_pv"], f"{prefix}.add_to_cart_rate_pv"),
        f"{prefix}_ctor_official": _scalar(stats["click_to_orders_rate_sku_pv"], f"{prefix}.click_to_orders_rate_sku_pv"),
        f"{prefix}_unique_impressions": _scalar(stats["product_impression_uv"], f"{prefix}.product_impression_uv"),
        f"{prefix}_unique_clicks": _scalar(stats["product_click_uv"], f"{prefix}.product_click_uv"),
        f"{prefix}_unique_click_rate_official": _scalar(stats["product_ctr_uv"], f"{prefix}.product_ctr_uv"),
        f"{prefix}_unique_atc_users": _scalar(stats["add_to_cart_users_uv"], f"{prefix}.add_to_cart_users_uv"),
        f"{prefix}_unique_atc_rate_official": _scalar(stats["add_to_cart_rate_uv"], f"{prefix}.add_to_cart_rate_uv"),
        f"{prefix}_unique_click_conversion_rate_official": _scalar(stats["click_to_orders_rate_sku_uv"], f"{prefix}.click_to_orders_rate_sku_uv"),
    }


def _zero_common(prefix: str) -> dict[str, str]:
    fields = _common({
        "gmv": {"currency_code": "PHP", "amount": "0"}, "orders": "0", "sku_orders": "0", "items_sold": "0", "customers": "0",
        "aov_sku": {"currency_code": "PHP", "amount": "0"}, "product_impression_pv": "0", "product_impression_uv": "0",
        "product_click_pv": "0", "product_click_uv": "0", "product_ctr_pv": "0", "product_ctr_uv": "0", "add_to_cart_cnt_pv": "0",
        "add_to_cart_users_uv": "0", "add_to_cart_rate_pv": "0", "add_to_cart_rate_uv": "0", "click_to_orders_rate_sku_pv": "0", "click_to_orders_rate_sku_uv": "0",
    }, prefix)
    return fields


def _channel(stats: dict[str, Any] | None, prefix: str, counter: str | None) -> dict[str, str]:
    values = _zero_common(prefix) if stats is None else _common(stats, prefix)
    values[f"{prefix}_attributed_gmv"] = values.pop(f"{prefix}_gmv")
    values[f"{prefix}_attributed_orders"] = values.pop(f"{prefix}_orders")
    values[f"{prefix}_attributed_sku_orders"] = values.pop(f"{prefix}_sku_orders")
    values[f"{prefix}_attributed_units_sold"] = values.pop(f"{prefix}_units_sold")
    values[f"{prefix}_attributed_aov"] = values.pop(f"{prefix}_average_order_value")
    source = stats or {"gmv_direct": {"currency_code": "PHP", "amount": "0"}, "gmv_indirect": {"currency_code": "PHP", "amount": "0"}, "sku_orders_direct": "0", "sku_orders_indirect": "0", "items_sold_direct": "0", "items_sold_indirect": "0", **({counter: "0"} if counter else {})}
    values.update({
        f"{prefix}_gmv": _money(source["gmv_direct"], f"{prefix}.gmv_direct"),
        f"{prefix}_indirect_gmv": _money(source["gmv_indirect"], f"{prefix}.gmv_indirect"),
        f"{prefix}_sku_orders": _scalar(source["sku_orders_direct"], f"{prefix}.sku_orders_direct"),
        f"{prefix}_indirect_sku_orders": _scalar(source["sku_orders_indirect"], f"{prefix}.sku_orders_indirect"),
        f"{prefix}_units_sold": _scalar(source["items_sold_direct"], f"{prefix}.items_sold_direct"),
        f"{prefix}_indirect_units_sold": _scalar(source["items_sold_indirect"], f"{prefix}.items_sold_indirect"),
    })
    if counter:
        values[f"{prefix}_{counter}"] = _scalar(source[counter], f"{prefix}.{counter}")
    return values


def _affiliate(stats: dict[str, Any] | None) -> dict[str, str]:
    if stats is None:
        stats = {**{key: "0" for key in ["orders", "sku_orders", "items_sold", "customers", "promoting_creators", "affiliate_live_go_live_cnt", "affiliate_video_new_video_cnt", "product_impression_pv", "product_impression_uv", "product_click_pv", "product_click_uv", "product_ctr_pv", "product_ctr_uv", "add_to_cart_cnt_pv", "add_to_cart_users_uv", "add_to_cart_rate_pv", "add_to_cart_rate_uv", "click_to_orders_rate_sku_pv", "click_to_orders_rate_sku_uv", "affiliate_live_product_impression_pv", "affiliate_live_product_impression_uv", "affiliate_live_product_click_pv", "affiliate_live_product_click_uv", "affiliate_live_product_ctr_pv", "affiliate_live_product_ctr_uv", "affiliate_live_add_to_cart_cnt_pv", "affiliate_live_add_to_cart_users_uv", "affiliate_live_add_to_cart_rate_pv", "affiliate_live_add_to_cart_rate_uv", "affiliate_live_click_to_orders_rate_sku_pv", "affiliate_live_click_to_orders_rate_sku_uv", "affiliate_video_product_impression_pv", "affiliate_video_product_impression_uv", "affiliate_video_product_click_pv", "affiliate_video_product_click_uv", "affiliate_video_product_ctr_pv", "affiliate_video_product_ctr_uv", "affiliate_video_add_to_cart_cnt_pv", "affiliate_video_add_to_cart_users_uv", "affiliate_video_add_to_cart_rate_pv", "affiliate_video_add_to_cart_rate_uv", "affiliate_video_click_to_orders_rate_sku_pv", "affiliate_video_click_to_orders_rate_sku_uv"]}, **{key: {"currency_code": "PHP", "amount": "0"} for key in ["gmv", "aov_sku", "affiliate_live_gmv", "affiliate_live_gmv_direct", "affiliate_live_gmv_indirect", "affiliate_video_gmv", "affiliate_video_gmv_direct", "affiliate_video_gmv_indirect"]}}
    values = _common(stats, "affiliate")
    values["affiliate_attributed_gmv"] = values.pop("affiliate_gmv")
    values["affiliate_attributed_orders"] = values.pop("affiliate_orders")
    values["affiliate_attributed_sku_orders"] = values.pop("affiliate_sku_orders")
    values["affiliate_attributed_units_sold"] = values.pop("affiliate_units_sold")
    values["affiliate_attributed_aov"] = values.pop("affiliate_average_order_value")
    values["affiliate_promoting_creators"] = _scalar(stats["promoting_creators"], "affiliate.promoting_creators")
    values["affiliate_new_live_sessions"] = _scalar(stats["affiliate_live_go_live_cnt"], "affiliate.live_sessions")
    values["affiliate_new_videos"] = _scalar(stats["affiliate_video_new_video_cnt"], "affiliate.new_videos")
    for scope in ("live", "video"):
        values[f"affiliate_{scope}_attributed_gmv"] = _money(stats[f"affiliate_{scope}_gmv"], f"affiliate.{scope}.gmv")
        values[f"affiliate_{scope}_gmv"] = _money(stats[f"affiliate_{scope}_gmv_direct"], f"affiliate.{scope}.gmv_direct")
        values[f"affiliate_{scope}_indirect_gmv"] = _money(stats[f"affiliate_{scope}_gmv_indirect"], f"affiliate.{scope}.gmv_indirect")
        key_prefix = f"affiliate_{scope}_"
        values.update({
            f"affiliate_{scope}_impressions": _scalar(stats[key_prefix + "product_impression_pv"], key_prefix + "impressions"),
            f"affiliate_{scope}_clicks": _scalar(stats[key_prefix + "product_click_pv"], key_prefix + "clicks"),
            f"affiliate_{scope}_click_rate_official": _scalar(stats[key_prefix + "product_ctr_pv"], key_prefix + "ctr"),
            f"affiliate_{scope}_add_to_cart": _scalar(stats[key_prefix + "add_to_cart_cnt_pv"], key_prefix + "atc"),
            f"affiliate_{scope}_add_to_cart_rate_official": _scalar(stats[key_prefix + "add_to_cart_rate_pv"], key_prefix + "atc_rate"),
            f"affiliate_{scope}_ctor_official": _scalar(stats[key_prefix + "click_to_orders_rate_sku_pv"], key_prefix + "ctor"),
            f"affiliate_{scope}_unique_impressions": _scalar(stats[key_prefix + "product_impression_uv"], key_prefix + "unique_impressions"),
            f"affiliate_{scope}_unique_clicks": _scalar(stats[key_prefix + "product_click_uv"], key_prefix + "unique_clicks"),
            f"affiliate_{scope}_unique_click_rate_official": _scalar(stats[key_prefix + "product_ctr_uv"], key_prefix + "unique_ctr"),
            f"affiliate_{scope}_unique_atc_users": _scalar(stats[key_prefix + "add_to_cart_users_uv"], key_prefix + "unique_atc"),
            f"affiliate_{scope}_unique_atc_rate_official": _scalar(stats[key_prefix + "add_to_cart_rate_uv"], key_prefix + "unique_atc_rate"),
            f"affiliate_{scope}_unique_click_conversion_rate_official": _scalar(stats[key_prefix + "click_to_orders_rate_sku_uv"], key_prefix + "unique_ctor"),
        })
    return values


def _parse_product_daily_api(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    path = Path(file_meta["path"])
    try: envelope = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc: raise CleaningError("product_api_snapshot_invalid", f"cannot read product API snapshot: {path}") from exc
    if envelope.get("schema_version") != "seller_shop_product_daily_api_envelope_v1" or envelope.get("source_id") != "seller_product_analytics_daily_v2" or envelope.get("report_id") != report_id or str(envelope.get("shop", {}).get("seller_id")) != str(manifest["shop"]["seller_id"]):
        raise CleaningError("product_api_snapshot_identity_mismatch", f"unexpected product API snapshot identity: {path}")
    collections = envelope.get("collections")
    if not isinstance(collections, list) or len({item.get("metric_date") for item in collections if isinstance(item, dict)}) != len(collections):
        raise CleaningError("product_api_collection_invalid", "product API dates are missing or duplicated")
    contexts = file_meta.get("_work_unit_contexts") or {}
    if contexts:
        expected_dates = {str(context.get("metric_date")) for context in contexts.values()}
        observed_dates = {str(item.get("metric_date")) for item in collections}
        if observed_dates != expected_dates:
            raise CleaningError("product_api_coverage_mismatch", "product API dates differ from bound successful work units")
    dataset = _dataset_for(report_id, [], model); rows: list[dict[str, Any]] = []; source_ordinal = 0
    for collection in collections:
        metric_date = collection.get("metric_date"); channels = {item.get("channel_key"): item for item in collection.get("channels", [])}
        if set(channels) != {"total", "self_live", "self_video", "affiliate_content", "product_card"}: raise CleaningError("product_api_channel_set_incomplete", f"daily channel set incomplete: {metric_date}")
        maps = {}
        for key, channel in channels.items():
            items = channel.get("items")
            if not isinstance(items, list) or channel.get("total") != len(items): raise CleaningError("product_api_count_mismatch", f"channel count differs: {metric_date}/{key}")
            ids = [str(item.get("meta", {}).get("product_id") or "") for item in items]
            if any(not value.isdigit() for value in ids) or len(ids) != len(set(ids)): raise CleaningError("product_api_product_identity_invalid", f"channel product identity invalid: {metric_date}/{key}")
            maps[key] = dict(zip(ids, items))
        if not maps["total"]: raise CleaningError("product_api_success_empty", f"successful product date has no products: {metric_date}")
        if contexts:
            matching = [context for context in contexts.values() if str(context.get("metric_date")) == str(metric_date)]
            expected_total = matching[0].get("official_total_count") if matching else None
            if expected_total is None and matching: expected_total = (matching[0].get("pagination") or {}).get("official_total_count")
            if len(matching) != 1 or expected_total != len(maps["total"]): raise CleaningError("product_api_official_total_mismatch", f"official total differs: {metric_date}")
        for product_id, item in maps["total"].items():
            source_ordinal += 1; meta = item.get("meta") or {}; total = (item.get("stats_v3") or {}).get("total")
            if not isinstance(total, dict): raise CleaningError("product_api_total_stats_missing", f"total stats missing: {product_id}/{metric_date}")
            if meta.get("gmv_range") not in GMV_TIERS or meta.get("product_status") not in PRODUCT_STATUSES: raise CleaningError("product_api_enum_unsupported", f"unverified product enum: {product_id}/{metric_date}")
            row = _base_row(manifest, report_id, file_meta, f"api:{metric_date}", source_ordinal, batch_id)
            row.update({"metric_date": metric_date, "product_name": str(meta.get("product_name") or ""), "product_id": product_id, "gmv_tier": GMV_TIERS[meta["gmv_range"]], "listing_status": PRODUCT_STATUSES[meta["product_status"]], "currency": "PHP"})
            row.update(_common(total, "overall"))
            row.update({
                "overall_merchant_live_attributed_gmv": _money(total["self_live_gmv"], "overall.self_live_gmv"), "overall_merchant_live_gmv": _money(total["self_live_gmv_direct"], "overall.self_live_direct"), "overall_merchant_live_indirect_gmv": _money(total["self_live_gmv_indirect"], "overall.self_live_indirect"),
                "overall_merchant_video_attributed_gmv": _money(total["self_video_gmv"], "overall.self_video_gmv"), "overall_merchant_video_gmv": _money(total["self_video_gmv_direct"], "overall.self_video_direct"), "overall_merchant_video_indirect_gmv": _money(total["self_video_gmv_indirect"], "overall.self_video_indirect"),
                "overall_creator_attributed_gmv": _money(total["affiliate_gmv"], "overall.affiliate_gmv"), "overall_creator_live_attributed_gmv": _money(total["affiliate_live_gmv"], "overall.affiliate_live_gmv"), "overall_affiliate_live_gmv": _money(total["affiliate_live_gmv_direct"], "overall.affiliate_live_direct"), "overall_creator_live_indirect_gmv": _money(total["affiliate_live_gmv_indirect"], "overall.affiliate_live_indirect"),
                "overall_creator_video_attributed_gmv": _money(total["affiliate_video_gmv"], "overall.affiliate_video_gmv"), "overall_affiliate_video_gmv": _money(total["affiliate_video_gmv_direct"], "overall.affiliate_video_direct"), "overall_creator_video_indirect_gmv": _money(total["affiliate_video_gmv_indirect"], "overall.affiliate_video_indirect"), "overall_merchant_product_card_gmv": _money(total["product_card_gmv"], "overall.product_card_gmv"),
                "overall_tax_inclusive_gmv": _money(total["gmv_with_tax"], "overall.gmv_with_tax"), "overall_tax_amount": _money(total["tax"], "overall.tax"), "overall_tiktok_cofunded_gmv": _money(total["gmv_with_tts_co_funding"], "overall.cofunded"), "overall_shipping_fee": _money(total["shipping_fees"], "overall.shipping"), "overall_refund_amount": _money(total["refunds"], "overall.refunds"), "overall_refunded_units": _scalar(total["items_canceled_and_returned"], "overall.refunded_units"), "overall_refund_customers": _scalar(total["refund_customers_aggregated"], "overall.refund_customers"),
                "overall_mall_impressions": _scalar(total["shop_tab_listing_impression"], "overall.mall_impressions"), "overall_mall_clicks": _scalar(total["shop_tab_pv"], "overall.mall_clicks"), "overall_mall_unique_clicks": _scalar(total["shop_tab_uv"], "overall.mall_unique_clicks"), "overall_mall_estimated_customers": _scalar(total["shop_tab_customers"], "overall.mall_customers"), "overall_mall_click_rate_official": _scalar(total["shop_tab_ctr"], "overall.mall_ctr"), "overall_mall_click_conversion_rate_official": _scalar(total["shop_tab_conversion_rate"], "overall.mall_conversion"), "overall_mall_gmv": _money(total["shop_tab_gmv"], "overall.mall_gmv"), "overall_mall_units_sold": _scalar(total["shop_tab_items_sold"], "overall.mall_units"),
            })
            for channel_key, prefix, counter in (("self_live", "merchant_live", "new_live_sessions"), ("self_video", "merchant_video", "new_videos"), ("product_card", "merchant_product_card", None)):
                channel_item = maps[channel_key].get(product_id); stats = (channel_item.get("stats_v3") or {}).get(channel_key) if channel_item else None
                if prefix == "merchant_product_card": values = _channel(stats, prefix, None)
                else: values = _channel(stats, prefix, "go_live_cnt" if channel_key == "self_live" else "new_video_cnt"); values[f"{prefix}_{counter}"] = values.pop(f"{prefix}_{'go_live_cnt' if channel_key == 'self_live' else 'new_video_cnt'}")
                row.update(values)
            affiliate_item = maps["affiliate_content"].get(product_id); row.update(_affiliate((affiliate_item.get("stats_v3") or {}).get("affiliate_content") if affiliate_item else None))
            missing = [name for name in dataset["content_fields"] if name not in row]
            if missing: raise CleaningError("product_api_mapping_incomplete", f"unmapped product fields: {','.join(missing)}")
            row["record_key"] = record_key(dataset["name"], [row.get(name) for name in dataset["record_key_components"]]); row["source_row_key"] = _source_row_key(file_meta["sha256"], f"api:{metric_date}", source_ordinal); row["record_content_hash"] = _content_hash(dataset["name"], row, dataset["content_fields"]); rows.append(row)
    keys = [row["record_key"] for row in rows]
    if len(keys) != len(set(keys)): raise CleaningError("record_key_duplicate", "duplicate product/date rows in API snapshot")
    return dataset["name"], rows, {"source_file": str(path), "detail_rows": len(rows), "rejected_rows": 0, "row_conservation": True, "source_contract_version": "seller_product_analytics_daily_api_v2", "channel_zero_fill_semantics": "absent from complete official channel list means zero contribution"}
