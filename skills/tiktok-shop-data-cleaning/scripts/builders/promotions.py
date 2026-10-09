from __future__ import annotations

import re
from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_datetime,
    normalize_id,
    normalize_integer,
    normalize_money,
    normalize_percentage_text,
    normalize_text,
    read_xlsx_custom_properties,
    read_xlsx_rows_with_header,
)


COLUMNS = [
    "统计开始日期", "统计结束日期", "店铺ID", "营销活动ID", "活动名称", "活动状态", "活动类型",
    "活动开始时间", "活动结束时间", "营销活动GMV", "成交订单数", "商品成交件数", "日均客户数",
    "笔单价", "折扣金额", "平均折扣率", "营销活动ROI", "每位客户平均GMV", "店铺币种",
]


def _activity_period(value: Any) -> tuple[Any, Any]:
    text = normalize_text(value)
    if text is None:
        return None, None
    match = re.fullmatch(r"(.+?)\s+-\s+(.+)", text)
    if match is None:
        raise CleaningError("INVALID_DATETIME", f"无法拆分活动时间：{value}")
    return normalize_datetime(match.group(1)), normalize_datetime(match.group(2))


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    files = sources.files.get("promotion_performance", [])
    if len(files) != 1:
        raise CleaningError("MISSING_SOURCE", "营销活动明细需要唯一的精确区间文件")
    path = files[0]
    currency = normalize_text(read_xlsx_custom_properties(path).get("Currency"))
    output: list[dict[str, Any]] = []
    for raw in read_xlsx_rows_with_header(path, {"商品id", "活动名称", "状态", "活动时间"}):
        start_time, end_time = _activity_period(raw.get("活动时间"))
        gmv = normalize_money(raw.get("GMV (₱)"))
        discount = normalize_money(raw.get("折扣金额 (₱)"))
        output.append(
            {
                "统计开始日期": context.start_date,
                "统计结束日期": context.end_date,
                "店铺ID": context.shop_id,
                "营销活动ID": normalize_id(raw.get("商品id")),
                "活动名称": normalize_text(raw.get("活动名称")),
                "活动状态": normalize_text(raw.get("状态")),
                "活动类型": normalize_text(raw.get("类型")),
                "活动开始时间": start_time,
                "活动结束时间": end_time,
                "营销活动GMV": gmv,
                "成交订单数": normalize_integer(raw.get("成交订单数")),
                "商品成交件数": normalize_integer(raw.get("商品成交件数")),
                "日均客户数": normalize_money(raw.get("日均客户数")),
                "笔单价": normalize_money(raw.get("笔单价 (₱)")),
                "折扣金额": discount,
                "平均折扣率": normalize_percentage_text(raw.get("平均折扣率")),
                "营销活动ROI": normalize_money(raw.get("ROI")),
                "每位客户平均GMV": normalize_money(raw.get("每位客户的平均 GMV (₱)")),
                "店铺币种": currency,
            }
        )
    return pd.DataFrame(output, columns=COLUMNS)
