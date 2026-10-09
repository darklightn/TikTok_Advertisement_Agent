from __future__ import annotations

from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_date,
    normalize_datetime,
    normalize_money,
    normalize_text,
    read_rows,
)


COLUMNS = [
    "采集时间", "店铺ID", "店铺名称", "类别", "指标", "当前值", "单位", "较上期变化", "上期值",
    "行业均值", "行业分类", "评估开始", "评估结束", "指标日期", "分子", "分母", "官方状态", "统计口径",
]
PERCENT_VALUE_COLUMNS = {"当前值", "较上期变化", "上期值", "行业均值"}


def _metric_value(value: Any, percent: bool = False) -> float | int | None:
    number = normalize_money(value)
    if number is None:
        return None
    return float(number) / 100 if percent else number


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    files = sources.files.get("fulfillment_snapshot", [])
    if len(files) != 1:
        raise CleaningError("MISSING_SOURCE", "履约表现明细需要唯一最新快照")
    output: list[dict[str, Any]] = []
    for raw in read_rows(files[0]):
        unit = normalize_text(raw.get("单位"))
        row: dict[str, Any] = {
            "采集时间": normalize_datetime(raw.get("采集时间")), "店铺ID": context.shop_id, "店铺名称": context.shop_root.name,
            "类别": normalize_text(raw.get("类别")), "指标": normalize_text(raw.get("指标")), "单位": unit,
            "行业分类": normalize_text(raw.get("行业分类")), "评估开始": normalize_date(raw.get("评估开始")),
            "评估结束": normalize_date(raw.get("评估结束")), "指标日期": normalize_date(raw.get("指标日期")),
            "分子": _metric_value(raw.get("分子")), "分母": _metric_value(raw.get("分母")),
            "官方状态": normalize_text(raw.get("官方状态")), "统计口径": normalize_text(raw.get("统计口径")),
        }
        row.update({column: _metric_value(raw.get(column), unit == "%") for column in PERCENT_VALUE_COLUMNS})
        output.append(row)
    return pd.DataFrame(output, columns=COLUMNS)
