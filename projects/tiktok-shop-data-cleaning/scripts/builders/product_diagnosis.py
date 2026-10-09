from __future__ import annotations

from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_date,
    normalize_id,
    normalize_integer,
    normalize_money,
    normalize_placeholder,
    normalize_percentage_text,
    normalize_text,
    read_product_analytics_rows,
    read_rows,
    safe_divide,
)
from builders.product_common import (
    base_cost,
    cost_complete,
    load_effective_costs,
    load_inventory,
    load_products,
    load_skus,
    product_category,
    product_name,
    product_prices,
    product_status,
    sku_prices,
)


COLUMNS = [
    "统计开始日期", "统计结束日期", "店铺ID", "店铺名称", "商品ID", "商品名称", "商品类目", "商业状态快照日期", "当前商品状态",
    "当前最低售价", "当前最高售价", "库存快照日期", "SKU总数", "在售SKU数", "缺货SKU数", "低库存SKU数", "总库存", "可用库存",
    "锁定库存", "近30天销量", "最短可供应天数", "商品GMV", "订单数", "SKU订单数", "商品成交件数", "客户数", "AOV", "商品曝光次数",
    "商品点击量", "商品点击率", "加购次数", "加购率", "CTOR", "退款金额", "退款金额率", "已退款商品件数", "退款件数率", "取消/退货商品件数",
    "商家视频GMV", "达人归因GMV", "联盟视频GMV", "商品卡GMV", "关联GMV Max计划数", "GMV Max广告成本", "GMV Max SKU订单数", "GMV Max平均下单成本", "GMV Max总收入",
    "实际ROI", "GMV Max可用素材数", "GMV Max有消耗素材数", "区间新增评价数", "区间新增评价平均分", "区间差评数", "成本覆盖SKU数", "成本覆盖率", "估算商品毛利率",
    "保本ROI", "ROI安全差", "店铺币种", "广告币种", "成本币种",
]
AVAILABLE_STATUSES = {"已探索", "探索中"}


def _plan_from_file(path: Path, suffix: str) -> str:
    marker = f"__{suffix}"
    if not path.stem.endswith(marker):
        raise CleaningError("INVALID_SOURCE_NAME", f"原始文件名不符合精确区间规则：{path.name}")
    plan = path.stem[: -len(marker)].strip()
    if not plan:
        raise CleaningError("INVALID_SOURCE_NAME", f"原始文件名缺少计划名称：{path.name}")
    return plan


def _creative_context(path: Path, suffix: str, plans: set[str]) -> tuple[str, str]:
    ending = f"__{suffix}"
    for plan in sorted(plans, key=len, reverse=True):
        prefix = f"{plan}__"
        if path.stem.startswith(prefix) and path.stem.endswith(ending):
            product_context = path.stem[len(prefix) : -len(ending)]
            if product_context:
                return plan, product_context
    raise CleaningError("INVALID_SOURCE_NAME", f"无法解析计划商品素材文件名：{path.name}")


def _one_currency(values: set[str], label: str) -> str | None:
    if len(values) > 1:
        raise CleaningError("CURRENCY_CONFLICT", f"{label}存在多个币种：{sorted(values)}")
    return next(iter(values)) if values else None


def _inventory_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {}
    total = available = locked = sales = 0
    out_of_stock: set[str] = set()
    low_stock: set[str] = set()
    numeric_days: list[float] = []
    greater_than_sixty = False
    for row in rows:
        sku_id = normalize_id(row.get("SKU ID"))
        total += normalize_integer(row.get("总库存")) or 0
        current_available = normalize_integer(row.get("可用库存"))
        available += current_available or 0
        locked += normalize_integer(row.get("锁定库存")) or 0
        sales += normalize_integer(row.get("近30天销量")) or 0
        status = normalize_text(row.get("库存状态（计算）"))
        is_out = status == "缺货" or (current_available is not None and current_available <= 0)
        if sku_id and is_out:
            out_of_stock.add(sku_id)
        elif sku_id and status == "需关注":
            low_stock.add(sku_id)
        raw_days = normalize_text(row.get("官方可供应天数"))
        if raw_days == ">60":
            greater_than_sixty = True
        elif raw_days is not None:
            number = normalize_money(raw_days)
            if number is not None:
                numeric_days.append(float(number))
    minimum_days: float | int | str | None
    if numeric_days:
        value = min(numeric_days)
        minimum_days = int(value) if value.is_integer() else value
    else:
        minimum_days = ">60" if greater_than_sixty else None
    return {
        "缺货SKU数": len(out_of_stock), "低库存SKU数": len(low_stock), "总库存": total,
        "可用库存": available, "锁定库存": locked, "近30天销量": sales, "最短可供应天数": minimum_days,
    }


def _analytics_index(path: Path) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in read_product_analytics_rows(path):
        product_id = normalize_id(row.get("商品 ID"))
        if product_id is None:
            raise CleaningError("MISSING_KEY", "商品分析表现存在空商品ID")
        if product_id in result:
            raise CleaningError("DUPLICATE_SOURCE_KEY", f"商品分析表现存在重复商品ID：{product_id}")
        result[product_id] = row
    return result


def _order_returns(path: Path, skus: dict[str, dict[str, Any]]) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    seen: set[tuple[str, str]] = set()
    for row in read_rows(path):
        order_id = normalize_id(row.get("Order ID"))
        sku_id = normalize_id(row.get("SKU ID"))
        if order_id is None or sku_id is None:
            raise CleaningError("MISSING_KEY", "订单明细存在空Order ID或SKU ID")
        key = (order_id, sku_id)
        if key in seen:
            raise CleaningError("DUPLICATE_SOURCE_KEY", f"订单明细存在重复事实键：{key}")
        seen.add(key)
        sku = skus.get(sku_id)
        product_id = sku.get("product_id") if sku else None
        if product_id is None:
            continue
        cancelled = normalize_placeholder(row.get("Cancelled Time")) is not None or (normalize_text(row.get("Order Status")) or "").casefold() in {"canceled", "cancelled"}
        quantity = normalize_integer(row.get("Quantity")) if cancelled else normalize_integer(row.get("Sku Quantity of return"))
        totals[product_id] += quantity or 0
    return totals


def _rating_summary(path: Path, start: date, end: date) -> dict[str, dict[str, Any]]:
    ratings: dict[str, list[float]] = defaultdict(list)
    for row in read_rows(path):
        rating_date = normalize_date(row.get("review_date"))
        product_id = normalize_id(row.get("product_id"))
        rating = normalize_money(row.get("rating"))
        if product_id and rating_date and start <= rating_date <= end and rating is not None:
            ratings[product_id].append(float(rating))
    return {
        product_id: {
            "区间新增评价数": len(values),
            "区间新增评价平均分": sum(values) / len(values),
            "区间差评数": sum(1 for value in values if value <= 2),
        }
        for product_id, values in ratings.items()
    }


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "商品经营诊断必须提供日期范围")
    commercial_date = sources.metadata["commercial_snapshot_date"]
    inventory_date = sources.metadata["inventory_snapshot_date"]
    products = load_products(sources.files["product_status_products"][0])
    skus = load_skus(sources.files["product_status_skus"][0])
    inventory = load_inventory(sources.files["inventory_snapshot"][0])
    costs = load_effective_costs(sources.files["cost_table"][0], commercial_date)
    analytics = _analytics_index(sources.files["product_analytics"][0])
    returns = _order_returns(sources.files["order_detail"][0], skus)
    ratings = _rating_summary(sources.files["rating_detail"][0], context.start_date, context.end_date)

    seller_ids = {item["seller_id"] for item in products.values() if item["seller_id"]}
    if len(seller_ids) > 1:
        raise CleaningError("IDENTITY_CONFLICT", "products快照存在多个seller_id")
    fallback_shop_id = context.shop_id or (next(iter(seller_ids)) if seller_ids else None)

    inventory_by_product: dict[str, list[dict[str, Any]]] = defaultdict(list)
    sales_by_sku: dict[str, int] = {}
    for sku_id, row in inventory.items():
        product_id = normalize_id(row.get("商品ID"))
        if product_id:
            inventory_by_product[product_id].append(row)
        sales_by_sku[sku_id] = normalize_integer(row.get("近30天销量")) or 0

    skus_by_product: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sku in skus.values():
        if sku["product_id"]:
            skus_by_product[sku["product_id"]].append(sku)

    performance_suffix = str(sources.metadata["performance_period_suffix"])
    plan_products: dict[str, dict[str, Any]] = defaultdict(lambda: {"plans": set(), "cost": 0.0, "orders": 0, "revenue": 0.0, "currencies": set(), "names": []})
    product_names_by_plan: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    plans: set[str] = set()
    for path in sources.files["campaign_product_performance"]:
        plan = _plan_from_file(path, performance_suffix)
        plans.add(plan)
        for row in read_rows(path):
            product_id = normalize_id(row.get("Product ID"))
            if product_id is None:
                raise CleaningError("MISSING_KEY", f"{path.name}存在空Product ID")
            state = plan_products[product_id]
            state["plans"].add(plan)
            state["cost"] += float(normalize_money(row.get("成本")) or 0)
            state["orders"] += normalize_integer(row.get("SKU 订单数")) or 0
            state["revenue"] += float(normalize_money(row.get("总收入")) or 0)
            currency = normalize_text(row.get("Currency"))
            if currency:
                state["currencies"].add(currency)
            name = normalize_text(row.get("商品名称"))
            if name:
                state["names"].append(name)
                product_names_by_plan[plan][name].add(product_id)

    creative_suffix = str(sources.metadata["creative_period_suffix"])
    creative_states: dict[tuple[str, str, str], dict[str, Any]] = {}
    for path in sources.files["campaign_product_creative_performance"]:
        plan, product_context = _creative_context(path, creative_suffix, plans)
        for row in read_rows(path):
            product_id = normalize_id(row.get("product_id"))
            if product_id is None:
                matches = product_names_by_plan[plan].get(product_context, set())
                if len(matches) != 1:
                    raise CleaningError("MISSING_KEY", f"素材文件{path.name}无法唯一确定商品ID")
                product_id = next(iter(matches))
            creative_type = normalize_text(row.get("Creative type"))
            if creative_type is None:
                raise CleaningError("MISSING_KEY", f"{path.name}存在空Creative type")
            if creative_type.casefold() == "product card":
                token = creative_type
            else:
                token = normalize_id(row.get("Post ID"))
                if token is None:
                    raise CleaningError("MISSING_KEY", f"{path.name}的Video素材缺少Post ID")
            state = creative_states.setdefault((plan, product_id, token), {"available": False, "cost": 0.0})
            state["available"] = state["available"] or normalize_text(row.get("Status")) in AVAILABLE_STATUSES
            state["cost"] += float(normalize_money(row.get("成本")) or 0)

    ratings_by_product = ratings
    product_ids = set(analytics) | set(plan_products)
    product_ids.update(product_id for product_id, product in products.items() if product_status(product) == "可售")
    output: list[dict[str, Any]] = []
    for product_id in sorted(product_ids):
        product = products.get(product_id)
        analytic = analytics.get(product_id)
        advertising = plan_products.get(product_id)
        product_skus = skus_by_product.get(product_id, [])
        current_status = product_status(product)
        minimum_price, maximum_price = product_prices(product)
        inventory_summary = _inventory_summary(inventory_by_product.get(product_id, []))
        record = product["record"] if product else {}
        sku_total = normalize_integer(record.get("total_sku_count"))
        if sku_total is None and product_skus:
            sku_total = len(product_skus)
        inactive = normalize_integer(record.get("inactive_sku_count")) or 0
        active_skus = 0 if current_status not in {None, "可售"} else (max(sku_total - inactive, 0) if sku_total is not None else None)

        gmv = normalize_money(analytic.get("全部.GMV")) if analytic else None
        orders = normalize_integer(analytic.get("全部.订单数")) if analytic else None
        sku_orders = normalize_integer(analytic.get("全部.SKU 订单数")) if analytic else None
        units = normalize_integer(analytic.get("全部.商品成交件数")) if analytic else None
        customers = normalize_integer(analytic.get("全部.预计客户数")) if analytic else None
        impressions = normalize_integer(analytic.get("全部.商品曝光次数")) if analytic else None
        clicks = normalize_integer(analytic.get("全部.商品点击量")) if analytic else None
        additions = normalize_integer(analytic.get("全部.加购次数")) if analytic else None
        refund = normalize_money(analytic.get("全部.退款金额")) if analytic else None
        refunded_units = normalize_integer(analytic.get("全部.已退款的商品件数")) if analytic else None

        effective_costs = [costs[sku["sku_id"]] for sku in product_skus if sku["sku_id"] in costs]
        cost_currencies = {cost["成本币种"] for cost in effective_costs if cost.get("成本币种")}
        cost_currency = _one_currency(cost_currencies, f"商品{product_id}成本")
        covered = sum(1 for cost in effective_costs if cost_complete(cost))
        margin_numerator = 0.0
        margin_denominator = 0.0
        margin_blocked = False
        has_sales = False
        for sku in product_skus:
            sales = sales_by_sku.get(sku["sku_id"], 0)
            if sales <= 0:
                continue
            has_sales = True
            cost = costs.get(sku["sku_id"])
            price, _, price_currency = sku_prices(sku)
            unit_cost = base_cost(cost)
            if not cost_complete(cost) or price is None or float(price) <= 0 or price_currency != cost.get("成本币种"):
                margin_blocked = True
                break
            margin_numerator += (float(price) - float(unit_cost) - float(price) * float(cost["平台费率"])) * sales
            margin_denominator += float(price) * sales
        margin = None if margin_blocked or not has_sales or margin_denominator <= 0 else margin_numerator / margin_denominator
        break_even = safe_divide(1, margin) if margin is not None and margin > 0 else None

        ad_cost = advertising["cost"] if advertising else None
        ad_orders = advertising["orders"] if advertising else None
        ad_revenue = advertising["revenue"] if advertising else None
        actual_roi = safe_divide(ad_revenue, ad_cost)
        creative_for_product = [state for (plan, pid, token), state in creative_states.items() if pid == product_id]
        rating = ratings_by_product.get(product_id, {})
        shop_currency = product.get("currency") if product else None
        ad_currency = _one_currency(advertising["currencies"], f"商品{product_id}广告") if advertising else None
        output.append({
            "统计开始日期": context.start_date, "统计结束日期": context.end_date,
            "店铺ID": product.get("seller_id") if product else fallback_shop_id, "店铺名称": context.shop_root.name,
            "商品ID": product_id, "商品名称": product_name(product) or (normalize_text(analytic.get("商品名")) if analytic else None) or (advertising["names"][0] if advertising and advertising["names"] else None),
            "商品类目": product_category(product), "商业状态快照日期": commercial_date, "当前商品状态": current_status,
            "当前最低售价": minimum_price, "当前最高售价": maximum_price, "库存快照日期": inventory_date,
            "SKU总数": sku_total, "在售SKU数": active_skus, **inventory_summary,
            "商品GMV": gmv, "订单数": orders, "SKU订单数": sku_orders, "商品成交件数": units, "客户数": customers,
            "AOV": normalize_money(analytic.get("全部.平均订单金额（SKU 订单）")) if analytic else None, "商品曝光次数": impressions, "商品点击量": clicks, "商品点击率": normalize_percentage_text(analytic.get("全部.商品点击率")) if analytic else None,
            "加购次数": additions, "加购率": normalize_percentage_text(analytic.get("全部.加购率")) if analytic else None, "CTOR": normalize_percentage_text(analytic.get("全部.CTOR（SKU 订单）")) if analytic else None,
            "退款金额": refund, "退款金额率": safe_divide(refund, gmv), "已退款商品件数": refunded_units, "退款件数率": safe_divide(refunded_units, units),
            "取消/退货商品件数": returns.get(product_id, 0),
            "商家视频GMV": normalize_money(analytic.get("全部.商家视频 GMV")) if analytic else None,
            "达人归因GMV": normalize_money(analytic.get("全部.达人归因 GMV")) if analytic else None,
            "联盟视频GMV": normalize_money(analytic.get("全部.联盟视频商品交易总额")) if analytic else None,
            "商品卡GMV": normalize_money(analytic.get("全部.商家商品卡 GMV")) if analytic else None,
            "关联GMV Max计划数": len(advertising["plans"]) if advertising else None,
            "GMV Max广告成本": ad_cost, "GMV Max SKU订单数": ad_orders, "GMV Max平均下单成本": safe_divide(ad_cost, ad_orders),
            "GMV Max总收入": ad_revenue, "实际ROI": actual_roi,
            "GMV Max可用素材数": sum(1 for state in creative_for_product if state["available"]),
            "GMV Max有消耗素材数": sum(1 for state in creative_for_product if state["cost"] > 0),
            **rating,
            "成本覆盖SKU数": covered, "成本覆盖率": safe_divide(covered, sku_total),
            "估算商品毛利率": margin, "保本ROI": break_even, "ROI安全差": actual_roi - break_even if actual_roi is not None and break_even is not None else None,
            "店铺币种": shop_currency, "广告币种": ad_currency, "成本币种": cost_currency,
        })
    return pd.DataFrame(output, columns=COLUMNS)
