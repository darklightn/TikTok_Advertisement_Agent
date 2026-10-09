from __future__ import annotations

from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_id,
    normalize_integer,
    normalize_money,
    normalize_placeholder,
    normalize_text,
    read_product_analytics_rows,
    read_rows,
    safe_divide,
    select_official_overview_total_row,
)
from builders.product_common import load_inventory, load_products, product_status


COLUMNS = [
    "统计开始日期", "统计结束日期", "统计天数", "店铺ID", "店铺名称", "店铺GMV", "订单数", "SKU订单数", "商品成交件数", "客户数", "AOV",
    "商品曝光次数", "商品点击量", "商品点击率", "加购次数", "加购率", "CTOR", "退款金额", "退款金额率", "已退款商品件数", "取消/退货商品件数",
    "商家视频GMV", "达人归因GMV", "联盟视频GMV", "商品卡GMV", "GMV Max广告总成本", "GMV Max SKU订单数", "GMV Max总收入", "实际ROI", "计划总数", "运行计划数", "有消耗计划数",
    "健康快照日期", "账号健康分", "违规分", "商责取消率", "延迟发货率", "商责差评率", "商家责任退货退款率", "履约快照日期", "快速发货率", "待发货至签收平均时长",
    "在售商品数", "缺货SKU数", "低库存SKU数", "店铺币种", "广告币种",
]


def _sum(rows: list[dict[str, Any]], field: str, integer: bool = False) -> float | int:
    if integer:
        return sum(normalize_integer(row.get(field)) or 0 for row in rows)
    return sum(float(normalize_money(row.get(field)) or 0) for row in rows)


def _one_currency(values: set[str], label: str) -> str | None:
    if len(values) > 1:
        raise CleaningError("CURRENCY_CONFLICT", f"{label}存在多个币种：{sorted(values)}")
    return next(iter(values)) if values else None


def _health_value(row: dict[str, Any] | None) -> float | int | None:
    if row is None:
        return None
    raw = normalize_placeholder(row.get("当前值"))
    if raw is None:
        return None
    text = normalize_text(raw)
    if text and text.endswith("%"):
        value = normalize_money(text[:-1])
        return None if value is None else float(value) / 100
    return normalize_money(raw)


def _metric_index(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        metric = normalize_text(row.get("指标"))
        if metric is None:
            continue
        if metric in result:
            raise CleaningError("DUPLICATE_SOURCE_KEY", f"快照存在重复指标：{metric}")
        result[metric] = row
    return result


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "店铺诊断必须提供日期范围")
    analytics = read_product_analytics_rows(sources.files["product_analytics"][0])
    orders = read_rows(sources.files["order_detail"][0])
    products = load_products(sources.files["product_status_products"][0])
    inventory = load_inventory(sources.files["inventory_snapshot"][0])

    seller_ids = {item["seller_id"] for item in products.values() if item["seller_id"]}
    if len(seller_ids) > 1:
        raise CleaningError("IDENTITY_CONFLICT", "products快照存在多个seller_id")
    shop_id = context.shop_id or (next(iter(seller_ids)) if seller_ids else None)
    shop_currencies = {item["currency"] for item in products.values() if item["currency"]}
    shop_currency = _one_currency(shop_currencies, "products快照")

    gmv = _sum(analytics, "全部.GMV")
    sku_orders = _sum(analytics, "全部.SKU 订单数", integer=True)
    units = _sum(analytics, "全部.商品成交件数", integer=True)
    impressions = _sum(analytics, "全部.商品曝光次数", integer=True)
    clicks = _sum(analytics, "全部.商品点击量", integer=True)
    additions = _sum(analytics, "全部.加购次数", integer=True)
    refund = _sum(analytics, "全部.退款金额")
    refunded_units = _sum(analytics, "全部.已退款的商品件数", integer=True)

    order_ids = {normalize_id(row.get("Order ID")) for row in orders}
    order_ids.discard(None)
    buyers = {normalize_text(row.get("Buyer Username")) for row in orders}
    buyers.discard(None)
    cancel_return = 0
    for order in orders:
        cancelled = normalize_placeholder(order.get("Cancelled Time")) is not None or (normalize_text(order.get("Order Status")) or "").casefold() in {"canceled", "cancelled"}
        cancel_return += (normalize_integer(order.get("Quantity")) if cancelled else normalize_integer(order.get("Sku Quantity of return"))) or 0

    overview_rows: list[dict[str, Any]] = []
    for path in sources.files["advertiser_overview"]:
        overview_rows.extend(read_rows(path))
    selected_overview = [select_official_overview_total_row(overview_rows)]
    ad_cost = _sum(selected_overview, "成本")
    ad_orders = _sum(selected_overview, "SKU orders (Current shop)", integer=True)
    ad_revenue = _sum(selected_overview, "Gross revenue (Current shop)")
    overview_currencies = {value for row in selected_overview if (value := normalize_text(row.get("币种")))}

    campaigns: dict[str, dict[str, Any]] = {}
    campaign_currencies: set[str] = set()
    for path in sources.files["campaign_performance"]:
        for raw in read_rows(path):
            campaign_id = normalize_id(raw.get("campaign_id"))
            if campaign_id is None:
                raise CleaningError("MISSING_KEY", f"{path.name}存在空campaign_id")
            state = campaigns.setdefault(campaign_id, {"cost": 0.0, "running": False})
            state["cost"] += float(normalize_money(raw.get("cost")) or 0)
            state["running"] = state["running"] or (
                normalize_text(raw.get("campaign_primary_status")) == "delivery_ok"
                and normalize_text(raw.get("campaign_status")) == "campaign_delivery_ok"
            )
            currency = normalize_text(raw.get("currency"))
            if currency:
                campaign_currencies.add(currency)
    ad_currency = _one_currency(overview_currencies, "GMV Max计划总览") if overview_currencies else _one_currency(campaign_currencies, "GMV Max计划表现")

    health = _metric_index(read_rows(sources.files["shop_health_snapshot"][0]))
    fulfillment = _metric_index(read_rows(sources.files["fulfillment_snapshot"][0]))
    fast_row = fulfillment.get("快速发货率")
    fast_value = normalize_money(fast_row.get("当前值")) if fast_row else None
    if fast_value is not None and fast_row and normalize_text(fast_row.get("单位")) == "%":
        fast_value = float(fast_value) / 100
    delivery_row = fulfillment.get("待发货–已签收时间")
    delivery_hours = normalize_money(delivery_row.get("当前值")) if delivery_row else None

    out_of_stock: set[str] = set()
    low_stock: set[str] = set()
    for sku_id, stock in inventory.items():
        available = normalize_integer(stock.get("可用库存"))
        status = normalize_text(stock.get("库存状态（计算）"))
        if status == "缺货" or (available is not None and available <= 0):
            out_of_stock.add(sku_id)
        elif status == "需关注":
            low_stock.add(sku_id)

    output = [{
        "统计开始日期": context.start_date, "统计结束日期": context.end_date,
        "统计天数": (context.end_date - context.start_date).days + 1, "店铺ID": shop_id, "店铺名称": context.shop_root.name,
        "店铺GMV": gmv, "订单数": len(order_ids), "SKU订单数": sku_orders, "商品成交件数": units,
        "客户数": len(buyers) if buyers else None, "AOV": safe_divide(gmv, sku_orders),
        "商品曝光次数": impressions, "商品点击量": clicks, "商品点击率": safe_divide(clicks, impressions),
        "加购次数": additions, "加购率": safe_divide(additions, clicks), "CTOR": safe_divide(sku_orders, clicks),
        "退款金额": refund, "退款金额率": safe_divide(refund, gmv), "已退款商品件数": refunded_units, "取消/退货商品件数": cancel_return,
        "商家视频GMV": _sum(analytics, "全部.商家视频 GMV"), "达人归因GMV": _sum(analytics, "全部.达人归因 GMV"),
        "联盟视频GMV": _sum(analytics, "全部.联盟视频商品交易总额"), "商品卡GMV": _sum(analytics, "全部.商家商品卡 GMV"),
        "GMV Max广告总成本": ad_cost, "GMV Max SKU订单数": ad_orders, "GMV Max总收入": ad_revenue, "实际ROI": normalize_money(selected_overview[0].get("ROI (Current shop)")),
        "计划总数": len(campaigns), "运行计划数": sum(1 for state in campaigns.values() if state["running"]),
        "有消耗计划数": sum(1 for state in campaigns.values() if state["cost"] > 0),
        "健康快照日期": sources.metadata["health_snapshot_date"], "账号健康分": _health_value(health.get("账号健康分")),
        "违规分": _health_value(health.get("违规分")), "商责取消率": _health_value(health.get("商责取消率")),
        "延迟发货率": _health_value(health.get("延迟发货率")), "商责差评率": _health_value(health.get("商责差评率")),
        "商家责任退货退款率": _health_value(health.get("商家责任退货退款率")),
        "履约快照日期": sources.metadata["fulfillment_snapshot_date"], "快速发货率": fast_value, "待发货至签收平均时长": delivery_hours,
        "在售商品数": sum(1 for product in products.values() if product_status(product) == "可售"),
        "缺货SKU数": len(out_of_stock), "低库存SKU数": len(low_stock), "店铺币种": shop_currency, "广告币种": ad_currency,
    }]
    return pd.DataFrame(output, columns=COLUMNS)
