from __future__ import annotations

from typing import Any

import pandas as pd

from common import CleaningContext, LocatedSources, normalize_integer, normalize_text, safe_divide
from builders.product_common import (
    COST_COMPONENTS,
    base_cost,
    load_effective_costs,
    load_inventory,
    load_products,
    load_skus,
    product_name,
    sku_prices,
)


COLUMNS = [
    "快照日期", "店铺ID", "商品ID", "商品名称", "SKU ID", "商家SKU", "SKU规格", "SKU状态", "当前预售状态",
    "当前售价", "列表价", "售价币种", "总库存", "可用库存", "锁定库存", "库存状态", "近30天销量",
    "未来30天销量预测", "建议补货数量", "官方可供应天数", "仓库名称", "成本生效日期", "成本币种",
    *COST_COMPONENTS[:4], "平台费率", *COST_COMPONENTS[4:], "单位基础成本", "按当前售价估算毛利率", "按当前售价估算保本ROI",
]


def _sku_spec(record: dict[str, Any]) -> str | None:
    properties = record.get("properties")
    if not isinstance(properties, list):
        return None
    parts: list[str] = []
    for item in properties:
        if not isinstance(item, dict):
            continue
        name = normalize_text(item.get("name"))
        value = normalize_text(item.get("value_name"))
        if name and value:
            parts.append(f"{name}: {value}")
    return "; ".join(parts) or None


def _preorder(value: Any) -> Any:
    normalized = normalize_integer(value)
    if normalized == 0:
        return "非预售"
    if normalized == 1:
        return "预售"
    return value


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    snapshot_date = sources.metadata["snapshot_date"]
    products = load_products(sources.files["product_status_products"][0])
    skus = load_skus(sources.files["product_status_skus"][0])
    inventory = load_inventory(sources.files["inventory_snapshot"][0])
    costs = load_effective_costs(sources.files["cost_table"][0], snapshot_date)
    rows: list[dict[str, Any]] = []

    for sku_id, sku in skus.items():
        product_id = sku["product_id"]
        product = products.get(product_id)
        stock = inventory.get(sku_id, {})
        record = sku["record"]
        current_price, list_price, price_currency = sku_prices(sku)
        cost = costs.get(sku_id)
        unit_cost = base_cost(cost)
        margin = None
        if (
            current_price is not None
            and float(current_price) > 0
            and unit_cost is not None
            and cost is not None
            and cost.get("平台费率") is not None
            and price_currency == cost.get("成本币种")
        ):
            margin = (float(current_price) - unit_cost - float(current_price) * float(cost["平台费率"])) / float(current_price)
        status = record.get("sku_status_info")
        status_value = status.get("status") if isinstance(status, dict) else None
        rows.append({
            "快照日期": snapshot_date,
            "店铺ID": product.get("seller_id") if product else None,
            "商品ID": product_id,
            "商品名称": product_name(product) or normalize_text(stock.get("商品名称")),
            "SKU ID": sku_id,
            "商家SKU": normalize_text(record.get("seller_sku")) or normalize_text(stock.get("商家SKU")),
            "SKU规格": _sku_spec(record) or normalize_text(stock.get("规格")),
            "SKU状态": status_value,
            "当前预售状态": _preorder(record.get("pre_order_status")),
            "当前售价": current_price,
            "列表价": list_price,
            "售价币种": price_currency,
            "总库存": normalize_integer(stock.get("总库存")),
            "可用库存": normalize_integer(stock.get("可用库存")),
            "锁定库存": normalize_integer(stock.get("锁定库存")),
            "库存状态": normalize_text(stock.get("库存状态（计算）")),
            "近30天销量": normalize_integer(stock.get("近30天销量")),
            "未来30天销量预测": stock.get("未来30天销量预测"),
            "建议补货数量": normalize_integer(stock.get("建议补货数量")),
            "官方可供应天数": stock.get("官方可供应天数"),
            "仓库名称": normalize_text(stock.get("仓库名称（观察值）")),
            **({name: cost.get(name) for name in ["成本生效日期", "成本币种", *COST_COMPONENTS, "平台费率"]} if cost else {}),
            "单位基础成本": unit_cost,
            "按当前售价估算毛利率": margin,
            "按当前售价估算保本ROI": safe_divide(1, margin) if margin is not None and margin > 0 else None,
        })
    return pd.DataFrame(rows, columns=COLUMNS)
