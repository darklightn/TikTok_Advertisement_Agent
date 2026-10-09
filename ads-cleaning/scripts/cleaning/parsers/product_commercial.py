"""Deterministic product and SKU commercial-status snapshot parser."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from ..conversion import _decimal, _optional_string, _required_string, _utc_datetime_value
from ..errors import CleaningError
from ..records import _content_hash, _source_row_key
from .shop_sources import _base_shop_row, _captured, _dataset, _finish, _json_text

EXPECTED_TABS = ((1, "all"), (5, "delisted"), (7, "draft"), (10, "deleted"))


def _nullable_decimal(value: Any, field: str) -> str | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    return _decimal(value, field)


def _epoch_utc(value: Any, field: str) -> str | None:
    if value is None or str(value).strip() in {"", "-", "0"}:
        return None
    try:
        return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (TypeError, ValueError, OSError) as exc:
        raise CleaningError("invalid_utc_datetime", f"invalid epoch in {field}: {value!r}") from exc


def _promotion_values(items: Any) -> tuple[str, str]:
    if items is None:
        items = []
    if not isinstance(items, list):
        raise CleaningError("product_commercial_shape_mismatch", "promotion collection must be a list")
    ids = []
    names = []
    for item in items:
        if not isinstance(item, dict):
            raise CleaningError("product_commercial_shape_mismatch", "promotion item must be an object")
        promotion_id = _optional_string(item.get("promotion_id"))
        promotion_name = _optional_string(item.get("promotion_name"))
        if promotion_id and promotion_id not in ids:
            ids.append(promotion_id)
        if promotion_name and promotion_name not in names:
            names.append(promotion_name)
    return _json_text(ids), _json_text(names)


def _sku_promotion_windows(items: Any) -> str:
    if items is None:
        items = []
    if not isinstance(items, list):
        raise CleaningError("product_commercial_shape_mismatch", "SKU promotion collection must be a list")
    windows = []
    for item in items:
        if not isinstance(item, dict):
            raise CleaningError("product_commercial_shape_mismatch", "SKU promotion item must be an object")
        schedule = item.get("time_schedule") or {}
        windows.append({
            "promotion_id": _optional_string(item.get("promotion_id")),
            "promotion_name_observed": _optional_string(item.get("promotion_name")),
            "promotion_template_raw": _optional_string(item.get("promotion_template")),
            "start_at_utc": _epoch_utc(schedule.get("start_time"), "sku promotion start_time"),
            "end_at_utc": _epoch_utc(schedule.get("end_time"), "sku promotion end_time"),
        })
    return _json_text(windows)


def _finish_with_sheet(dataset: dict[str, Any], row: dict[str, Any], file_meta: dict[str, Any], sheet: str, row_number: int) -> dict[str, Any]:
    finished = _finish(dataset, row, file_meta, row_number)
    finished["source_sheet"] = sheet
    finished["source_row_key"] = _source_row_key(file_meta["sha256"], sheet, row_number)
    finished["record_content_hash"] = _content_hash(dataset["name"], finished, dataset["content_fields"])
    return finished


def parse_product_commercial(manifest: dict[str, Any], report_id: str, file_meta: dict[str, Any], model: dict[str, Any], batch_id: str, snapshot: dict[str, Any]) -> list[tuple[str, list[dict[str, Any]], dict[str, Any]]]:
    product_dataset = _dataset(model, "shop_product_commercial_status_snapshot")
    sku_dataset = _dataset(model, "shop_sku_commercial_status_snapshot")
    report = next(item for item in manifest["reports"] if item.get("report_id") == report_id)
    manifest_currency = _optional_string(report.get("currency"))
    if report.get("currency_scope") != "shop_commerce":
        raise CleaningError("currency_scope_mismatch", "SKU commercial snapshot must use shop_commerce currency scope")
    tabs = snapshot.get("response", {}).get("data", {}).get("tabs")
    collection = snapshot.get("collection") or {}
    if not isinstance(tabs, list) or [(item.get("tab_id"), item.get("label_observed")) for item in tabs if isinstance(item, dict)] != list(EXPECTED_TABS):
        raise CleaningError("product_commercial_lifecycle_incomplete", "commercial snapshot lifecycle tabs differ from contract")
    if collection.get("pagination_complete") is not True or collection.get("lifecycle_tabs_complete") is not True:
        raise CleaningError("product_commercial_pagination_incomplete", "commercial snapshot completeness proof is missing")

    captured = _captured(snapshot)
    if captured != _utc_datetime_value(file_meta.get("captured_at_utc"), "file.captured_at_utc"):
        raise CleaningError("captured_at_mismatch", "commercial snapshot capture time differs from Manifest file metadata")
    products_out: list[dict[str, Any]] = []
    skus_out: list[dict[str, Any]] = []
    product_ids: set[str] = set()
    sku_ids: set[str] = set()
    for tab in tabs:
        products = tab.get("products")
        if not isinstance(products, list) or tab.get("total_product_count") != len(products):
            raise CleaningError("product_commercial_pagination_incomplete", f"tab {tab.get('tab_id')} product count differs")
        for product in products:
            if not isinstance(product, dict):
                raise CleaningError("product_commercial_shape_mismatch", "product must be an object")
            product_id = _required_string(str(product.get("product_id")) if product.get("product_id") is not None else None, "product_id")
            if product_id in product_ids:
                raise CleaningError("record_key_duplicate", f"duplicate product in lifecycle tabs: {product_id}")
            product_ids.add(product_id)
            skus = product.get("skus")
            if not isinstance(skus, list) or product.get("total_sku_count") != len(skus):
                raise CleaningError("product_commercial_sku_incomplete", f"SKU expansion differs for product {product_id}")

            promotion_ids, promotion_names = _promotion_values(product.get("promotion_infos"))
            effective_ids, effective_names = _promotion_values(product.get("effective_promotions"))
            product_row_number = len(products_out) + 1
            product_row = _base_shop_row(manifest, report_id, file_meta, batch_id, product_row_number)
            product_row.update({
                "product_id": product_id,
                "product_name_observed": _optional_string(product.get("product_name") or product.get("name") or product.get("product_title")),
                "source_tab_id": str(tab["tab_id"]),
                "listing_status_observed": tab["label_observed"],
                "product_status_raw": _optional_string(product.get("product_status")),
                "audit_status_raw": _optional_string(product.get("audit_status")),
                "product_main_status_raw": _optional_string((product.get("product_status_view") or {}).get("product_main_status")),
                "product_display_status_raw": _optional_string((product.get("product_status_view") or {}).get("product_display_status")),
                "is_visible_raw": _optional_string((product.get("visible_status") or {}).get("is_visible")),
                "visible_reasons_json": _json_text((product.get("visible_status") or {}).get("reasons") or []),
                "suspend_reason_json": _json_text(product.get("suspend_reason") or {}),
                "product_level_promotion_ids_json": promotion_ids,
                "product_level_promotion_names_observed_json": promotion_names,
                "effective_product_promotion_ids_json": effective_ids,
                "effective_product_promotion_names_observed_json": effective_names,
                "captured_at_utc": captured,
            })
            products_out.append(_finish_with_sheet(product_dataset, product_row, file_meta, "api_products", product_row_number))

            for sku in skus:
                if not isinstance(sku, dict):
                    raise CleaningError("product_commercial_shape_mismatch", "SKU must be an object")
                sku_id = _required_string(str(sku.get("id")) if sku.get("id") is not None else None, "sku_id")
                if sku_id in sku_ids:
                    raise CleaningError("record_key_duplicate", f"duplicate SKU in lifecycle tabs: {sku_id}")
                sku_ids.add(sku_id)
                price = sku.get("base_price") or {}
                list_price = _nullable_decimal(price.get("list_price"), "list_price")
                sale_price = _nullable_decimal(price.get("sale_price"), "sale_price")
                promotion_price = _nullable_decimal(price.get("promotion_price"), "promotion_price")
                currency = _optional_string(price.get("currency"))
                if any(value is not None for value in (list_price, sale_price, promotion_price)) and not currency:
                    raise CleaningError("currency_missing", f"priced SKU lacks currency: {sku_id}")
                if manifest_currency and currency and currency != manifest_currency:
                    raise CleaningError("currency_mismatch", f"SKU currency differs from Manifest currency: {sku_id}")
                sku_promotions = sku.get("sku_effect_promotions") or []
                sku_promotion_ids, sku_promotion_names = _promotion_values(sku_promotions)
                sku_row_number = len(skus_out) + 1
                sku_row = _base_shop_row(manifest, report_id, file_meta, batch_id, sku_row_number)
                sku_row.update({
                    "sku_id": sku_id,
                    "product_id": product_id,
                    "seller_sku": _optional_string(sku.get("seller_sku")),
                    "variation_json": _json_text(sku.get("properties") or []),
                    "source_tab_id": str(tab["tab_id"]),
                    "listing_status_observed": tab["label_observed"],
                    "sku_status_raw": _optional_string((sku.get("sku_status_info") or {}).get("status")),
                    "list_price": list_price,
                    "sale_price": sale_price,
                    "promotion_price": promotion_price,
                    "effective_price_calculated": promotion_price if promotion_price is not None else sale_price,
                    "currency": currency,
                    "currency_scope": "shop_commerce",
                    "sku_level_promotion_ids_json": sku_promotion_ids,
                    "sku_level_promotion_names_observed_json": sku_promotion_names,
                    "sku_level_promotion_windows_json": _sku_promotion_windows(sku_promotions),
                    "captured_at_utc": captured,
                })
                skus_out.append(_finish_with_sheet(sku_dataset, sku_row, file_meta, "api_skus", sku_row_number))

    if collection.get("product_count") != len(products_out) or collection.get("sku_count") != len(skus_out):
        raise CleaningError("product_commercial_collection_mismatch", "cleaned product/SKU counts differ from source collection proof")
    product_qa = {"source_file": file_meta["path"], "source_rows_excluding_header": len(products_out), "detail_rows": len(products_out), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0, "row_conservation": True, "summary_reconciliation": {"status": "not_applicable"}}
    sku_qa = {"source_file": file_meta["path"], "source_rows_excluding_header": len(skus_out), "detail_rows": len(skus_out), "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0, "row_conservation": True, "summary_reconciliation": {"status": "not_applicable", "inventory_fields_copied": False}}
    return [(product_dataset["name"], products_out, product_qa), (sku_dataset["name"], skus_out, sku_qa)]
