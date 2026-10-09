from __future__ import annotations

from typing import Any

import pandas as pd

from common import CleaningContext, CleaningError, LocatedSources, normalize_datetime, normalize_id, normalize_money, normalize_text, read_rows


COLUMNS = ["评价日期", "店铺ID", "商品ID", "SKU ID", "订单ID", "评分", "是否差评", "评价内容"]


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    files = sources.files.get("rating_detail", [])
    if len(files) != 1:
        raise CleaningError("MISSING_SOURCE", "商品评价明细需要唯一的精确区间文件")
    output: list[dict[str, Any]] = []
    for raw in read_rows(files[0]):
        rating = normalize_money(raw.get("rating"))
        output.append(
            {
                "评价日期": normalize_datetime(raw.get("review_date")),
                "店铺ID": context.shop_id,
                "商品ID": normalize_id(raw.get("product_id")),
                "SKU ID": normalize_id(raw.get("sku_id")),
                "订单ID": normalize_id(raw.get("order_id")),
                "评分": rating,
                "是否差评": None if rating is None else rating <= 2,
                "评价内容": normalize_text(raw.get("review_text")),
            }
        )
    return pd.DataFrame(output, columns=COLUMNS)
