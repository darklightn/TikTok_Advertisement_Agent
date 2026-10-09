from __future__ import annotations

from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_date,
    normalize_hour,
    normalize_id,
    normalize_integer,
    normalize_money,
    normalize_text,
    read_account_identity,
    read_rows,
    safe_divide,
)


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    columns = [
        "日期",
        "小时",
        "时区",
        "店铺ID",
        "广告户ID",
        "计划ID",
        "计划名称",
        "广告成本",
        "广告展示量",
        "广告点击量",
        "广告CTR",
        "广告CPC",
        "广告CPM",
        "GMV Max SKU订单数",
        "GMV Max平均下单成本",
        "GMV Max总收入",
        "实际ROI",
        "广告币种",
    ]
    account_files = sources.files.get("advertiser_account_status", [])
    hourly_files = sources.files.get("campaign_hourly", [])
    if len(account_files) != 1 or not hourly_files:
        raise CleaningError("MISSING_SOURCE", "计划小时表现缺少必要原始文件")
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "计划小时表现必须提供日期范围")
    account = read_account_identity(account_files[0])
    output: list[dict[str, Any]] = []
    for path in hourly_files:
        for raw in read_rows(path):
            metric_date = normalize_date(raw.get("metric_date"))
            if metric_date is None or not context.start_date <= metric_date <= context.end_date:
                continue
            cost = normalize_money(raw.get("cost"))
            impressions = normalize_integer(raw.get("impressions"))
            clicks = normalize_integer(raw.get("clicks"))
            orders = normalize_integer(raw.get("sku_orders"))
            revenue = normalize_money(raw.get("gross_revenue"))
            output.append(
                {
                    "日期": metric_date,
                    "小时": normalize_hour(raw.get("metric_hour")),
                    "时区": account["timezone"],
                    "店铺ID": account["shop_id"],
                    "广告户ID": account["advertiser_id"],
                    "计划ID": normalize_id(raw.get("campaign_id")),
                    "计划名称": normalize_text(raw.get("campaign_name")),
                    "广告成本": cost,
                    "广告展示量": impressions,
                    "广告点击量": clicks,
                    "广告CTR": safe_divide(clicks, impressions),
                    "广告CPC": safe_divide(cost, clicks),
                    "广告CPM": safe_divide(cost, impressions, 1000.0),
                    "GMV Max SKU订单数": orders,
                    "GMV Max平均下单成本": normalize_money(raw.get("cost_per_order_official")),
                    "GMV Max总收入": revenue,
                    "实际ROI": normalize_money(raw.get("roi_official")),
                    "广告币种": normalize_text(raw.get("currency")),
                }
            )
    if not output:
        raise CleaningError("EMPTY_SOURCE", "目标日期范围内没有计划小时表现数据行")
    return pd.DataFrame(output, columns=columns)
