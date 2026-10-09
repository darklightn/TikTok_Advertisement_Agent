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
    normalize_text,
    read_account_identity,
    read_rows,
    safe_divide,
    select_official_overview_total_row,
)


COLUMNS = [
    "统计开始日期", "统计结束日期", "统计天数", "店铺ID", "店铺名称", "广告户ID", "广告户名称",
    "计划总数", "运行计划数", "有消耗计划数", "广告总成本", "日均广告成本", "广告展示量",
    "广告点击量", "广告CTR", "广告CPC", "广告CPM", "GMV Max SKU订单数", "GMV Max平均下单成本",
    "GMV Max总收入", "实际ROI", "广告币种",
]


def _sum_values(rows: list[dict[str, Any]], field: str, integer: bool = False) -> float | int | None:
    parser = normalize_integer if integer else normalize_money
    values = [parser(row.get(field)) for row in rows]
    present = [value for value in values if value is not None]
    if not present:
        return None
    total = sum(present)
    return int(total) if integer else total


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "广告户诊断必须提供日期范围")
    account_files = sources.files.get("advertiser_account_status", [])
    overview_files = sources.files.get("advertiser_overview", [])
    if len(account_files) != 1 or len(overview_files) != 1:
        raise CleaningError("MISSING_SOURCE", "广告户诊断缺少唯一账户快照或计划总览")
    account = read_account_identity(account_files[0])
    overview = [select_official_overview_total_row(read_rows(overview_files[0]))]
    performance = [row for path in sources.files.get("campaign_performance", []) for row in read_rows(path)]
    if not performance:
        raise CleaningError("EMPTY_SOURCE", "精确区间计划表现没有数据行")

    campaign_ids = {normalize_id(row.get("campaign_id")) for row in performance}
    campaign_ids.discard(None)
    running_ids = {
        normalize_id(row.get("campaign_id"))
        for row in performance
        if normalize_text(row.get("campaign_primary_status")) == "delivery_ok"
        and normalize_text(row.get("campaign_status")) == "campaign_delivery_ok"
    }
    running_ids.discard(None)
    costs_by_campaign: dict[str, float] = {}
    for row in performance:
        campaign_id = normalize_id(row.get("campaign_id"))
        campaign_cost = normalize_money(row.get("cost"))
        if campaign_id is not None and campaign_cost is not None:
            costs_by_campaign[campaign_id] = costs_by_campaign.get(campaign_id, 0.0) + float(campaign_cost)

    cost = _sum_values(overview, "成本")
    orders = _sum_values(overview, "SKU orders (Current shop)", integer=True)
    revenue = _sum_values(overview, "Gross revenue (Current shop)")
    impressions = _sum_values(performance, "show_cnt", integer=True)
    clicks = _sum_values(performance, "click_cnt", integer=True)
    currencies = {normalize_text(row.get("币种")) for row in overview}
    currencies.discard(None)
    if len(currencies) != 1:
        raise CleaningError("CURRENCY_CONFLICT", "GMV Max计划总览无法确定唯一广告币种")
    days = (context.end_date - context.start_date).days + 1
    row = {
        "统计开始日期": context.start_date,
        "统计结束日期": context.end_date,
        "统计天数": days,
        "店铺ID": account["shop_id"],
        "店铺名称": context.shop_root.name,
        "广告户ID": account["advertiser_id"],
        "广告户名称": account["advertiser_name"],
        "计划总数": len(campaign_ids),
        "运行计划数": len(running_ids),
        "有消耗计划数": sum(1 for value in costs_by_campaign.values() if value > 0),
        "广告总成本": cost,
        "日均广告成本": safe_divide(cost, days),
        "广告展示量": impressions,
        "广告点击量": clicks,
        "广告CTR": safe_divide(clicks, impressions),
        "广告CPC": safe_divide(cost, clicks),
        "广告CPM": safe_divide(cost, impressions, 1000.0),
        "GMV Max SKU订单数": orders,
        "GMV Max平均下单成本": normalize_money(overview[0].get("Cost per order (Current shop)")),
        "GMV Max总收入": revenue,
        "实际ROI": normalize_money(overview[0].get("ROI (Current shop)")),
        "广告币种": next(iter(currencies)),
    }
    return pd.DataFrame([row], columns=COLUMNS)
