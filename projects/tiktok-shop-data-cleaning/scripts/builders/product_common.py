from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from common import (
    CleaningError,
    normalize_date,
    normalize_id,
    normalize_integer,
    normalize_money,
    normalize_placeholder,
    normalize_text,
    parse_json_object,
    read_xlsx_rows,
)


COST_COMPONENTS = (
    "单位采购成本",
    "单位头程成本",
    "单位关税及清关成本",
    "单位包装成本",
    "单位本地物流成本",
    "单位仓租分摊",
)


def _unique_by_id(rows: list[dict[str, Any]], field: str, label: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = normalize_id(row.get(field))
        if key is None:
            raise CleaningError("MISSING_KEY", f"{label}存在空{field}")
        if key in result:
            raise CleaningError("DUPLICATE_SOURCE_KEY", f"{label}存在重复{field}：{key}")
        result[key] = row
    return result


def load_products(path: Path) -> dict[str, dict[str, Any]]:
    rows = read_xlsx_rows(path)
    indexed = _unique_by_id(rows, "product_id", "products快照")
    result: dict[str, dict[str, Any]] = {}
    for product_id, row in indexed.items():
        record = parse_json_object(row.get("product_record_json"), "product_record_json")
        result[product_id] = {
            "row": row,
            "record": record,
            "product_id": product_id,
            "seller_id": normalize_id(record.get("seller_id")),
            "currency": normalize_text(row.get("currency")),
        }
    return result


def load_skus(path: Path) -> dict[str, dict[str, Any]]:
    rows = read_xlsx_rows(path)
    indexed = _unique_by_id(rows, "sku_id", "skus快照")
    result: dict[str, dict[str, Any]] = {}
    for sku_id, row in indexed.items():
        result[sku_id] = {
            "row": row,
            "record": parse_json_object(row.get("sku_record_json"), "sku_record_json"),
            "sku_id": sku_id,
            "product_id": normalize_id(row.get("product_id")),
            "currency": normalize_text(row.get("currency")),
        }
    return result


def load_inventory(path: Path) -> dict[str, dict[str, Any]]:
    return _unique_by_id(read_xlsx_rows(path), "SKU ID", "库存快照")


def normalize_fee(value: Any) -> float | None:
    value = normalize_placeholder(value)
    if value is None:
        return None
    text = normalize_text(value)
    if text is not None and text.endswith("%"):
        number = normalize_money(text[:-1])
        return None if number is None else float(number) / 100
    number = normalize_money(value)
    if number is None:
        return None
    numeric = float(number)
    return numeric / 100 if numeric > 1 else numeric


def load_effective_costs(path: Path, cutoff: date) -> dict[str, dict[str, Any]]:
    rows = read_xlsx_rows(path)
    candidates: dict[tuple[str, date], dict[str, Any]] = {}
    for row in rows:
        sku_id = normalize_id(row.get("SKU ID"))
        effective_date = normalize_date(row.get("生效日期"))
        if sku_id is None or effective_date is None:
            raise CleaningError("MISSING_KEY", "成本表的SKU ID和生效日期不得为空")
        normalized = {
            "成本生效日期": effective_date,
            "成本币种": normalize_text(row.get("币种")),
            **{name: normalize_money(row.get(name)) for name in COST_COMPONENTS},
            "平台费率": normalize_fee(row.get("平台费率（%）")),
        }
        key = (sku_id, effective_date)
        if key in candidates and candidates[key] != normalized:
            raise CleaningError("COST_CONFLICT", f"SKU {sku_id}在{effective_date}存在冲突成本记录")
        candidates[key] = normalized

    selected: dict[str, dict[str, Any]] = {}
    for (sku_id, effective_date), cost in candidates.items():
        if effective_date > cutoff:
            continue
        current = selected.get(sku_id)
        if current is None or effective_date > current["成本生效日期"]:
            selected[sku_id] = cost
    return selected


def product_name(product: dict[str, Any] | None) -> str | None:
    return normalize_text(product["record"].get("product_name")) if product else None


def product_category(product: dict[str, Any] | None) -> str | None:
    if not product:
        return None
    categories = product["record"].get("categories")
    if not isinstance(categories, list):
        return None
    valid = [item for item in categories if isinstance(item, dict) and normalize_text(item.get("name"))]
    if not valid:
        return None
    leaves = [item for item in valid if item.get("is_leaf") is True]
    chosen = max(leaves or valid, key=lambda item: normalize_integer(item.get("level")) or 0)
    return normalize_text(chosen.get("name"))


def product_status(product: dict[str, Any] | None) -> str | None:
    if not product:
        return None
    lifecycle = normalize_text(product["row"].get("lifecycle_status"))
    if lifecycle == "delisted":
        return "已下架"
    if lifecycle == "draft":
        return "草稿"
    if lifecycle == "deleted":
        return "已删除"
    visible = product["record"].get("visible_status")
    if isinstance(visible, dict) and isinstance(visible.get("is_visible"), bool):
        return "可售" if visible["is_visible"] else "不可见"
    return normalize_text(product["record"].get("product_status"))


def _positive_price(value: Any) -> float | int | None:
    number = normalize_money(value)
    return number if number is not None and float(number) > 0 else None


def sku_prices(sku: dict[str, Any]) -> tuple[float | int | None, float | int | None, str | None]:
    base = sku["record"].get("base_price")
    if not isinstance(base, dict):
        base = {}
    current = _positive_price(base.get("promotion_price")) or normalize_money(base.get("sale_price"))
    return current, normalize_money(base.get("list_price")), sku["currency"] or normalize_text(base.get("currency"))


def product_prices(product: dict[str, Any] | None) -> tuple[float | int | None, float | int | None]:
    if not product:
        return None, None
    price_range = product["record"].get("price_range")
    if not isinstance(price_range, dict):
        return None, None
    minimum = _positive_price(price_range.get("min_promotion_price")) or normalize_money(price_range.get("min_sale_price"))
    maximum = _positive_price(price_range.get("max_promotion_price")) or normalize_money(price_range.get("max_sale_price"))
    return minimum, maximum


def cost_complete(cost: dict[str, Any] | None) -> bool:
    return bool(
        cost
        and cost.get("成本币种") is not None
        and cost.get("平台费率") is not None
        and all(cost.get(name) is not None for name in COST_COMPONENTS)
    )


def base_cost(cost: dict[str, Any] | None) -> float | None:
    if not cost or not all(cost.get(name) is not None for name in COST_COMPONENTS):
        return None
    return sum(float(cost[name]) for name in COST_COMPONENTS)
