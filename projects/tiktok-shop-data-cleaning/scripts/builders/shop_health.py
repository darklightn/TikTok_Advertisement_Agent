from __future__ import annotations

from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_date,
    normalize_datetime,
    normalize_integer,
    normalize_money,
    normalize_percentage_text,
    normalize_placeholder,
    normalize_text,
    read_rows,
)


COLUMNS = ["采集时间", "店铺ID", "店铺名称", "类别", "指标", "当前值", "目标条件", "评估开始", "评估结束", "违规次数", "说明"]


def _current_value(value: Any) -> Any:
    normalized = normalize_placeholder(value)
    if normalized is None:
        return None
    text = normalize_text(normalized)
    if text is not None and text.endswith("%"):
        return normalize_percentage_text(text)
    number = normalize_money(normalized)
    return text if number is None else number


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    files = sources.files.get("shop_health_snapshot", [])
    if len(files) != 1:
        raise CleaningError("MISSING_SOURCE", "店铺健康明细需要唯一最新快照")
    output: list[dict[str, Any]] = []
    for raw in read_rows(files[0]):
        output.append(
            {
                "采集时间": normalize_datetime(raw.get("采集时间")), "店铺ID": context.shop_id,
                "店铺名称": context.shop_root.name, "类别": normalize_text(raw.get("类别")), "指标": normalize_text(raw.get("指标")),
                "当前值": _current_value(raw.get("当前值")), "目标条件": normalize_text(raw.get("目标条件")),
                "评估开始": normalize_date(raw.get("评估开始")), "评估结束": normalize_date(raw.get("评估结束")),
                "违规次数": normalize_integer(raw.get("违规次数")), "说明": normalize_text(raw.get("说明")),
            }
        )
    return pd.DataFrame(output, columns=COLUMNS)
