from __future__ import annotations

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
    normalize_text,
    read_rows,
)


COLUMNS = [
    "采集时间", "店铺ID", "订单ID", "售后单号", "售后申请时间", "售后类型", "售后原因", "客户说明",
    "订单实付", "退款金额", "处理状态", "退货物流状态", "退货物流时间", "平台标签", "客户凭证数量", "币种",
]


def _order_amounts(paths) -> dict[str, float | int | None]:
    amounts: dict[str, set[float | int]] = {}
    for path in paths:
        for raw in read_rows(path):
            order_id = normalize_id(raw.get("Order ID"))
            amount = normalize_money(raw.get("Order Amount"))
            if order_id is not None and amount is not None:
                amounts.setdefault(order_id, set()).add(amount)
    return {order_id: next(iter(values)) if len(values) == 1 else None for order_id, values in amounts.items()}


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    refund_files = sources.files.get("refund_snapshot", [])
    history_files = sources.files.get("order_history", [])
    if len(refund_files) != 1 or not history_files:
        raise CleaningError("MISSING_SOURCE", "退货退款明细需要唯一退款快照和订单历史")
    amount_by_order = _order_amounts(history_files)
    output: list[dict[str, Any]] = []
    for raw in read_rows(refund_files[0]):
        order_id = normalize_id(raw.get("订单ID"))
        output.append(
            {
                "采集时间": normalize_datetime(raw.get("采集时间")),
                "店铺ID": context.shop_id,
                "订单ID": order_id,
                "售后单号": normalize_id(raw.get("售后单号")),
                "售后申请时间": normalize_datetime(raw.get("售后申请时间")),
                "售后类型": normalize_text(raw.get("售后类型")),
                "售后原因": normalize_text(raw.get("售后原因")),
                "客户说明": normalize_text(raw.get("客户说明")),
                "订单实付": amount_by_order.get(order_id),
                "退款金额": normalize_money(raw.get("退款金额")),
                "处理状态": normalize_text(raw.get("处理状态")),
                "退货物流状态": normalize_text(raw.get("退货物流状态")),
                "退货物流时间": normalize_datetime(raw.get("退货物流时间")),
                "平台标签": normalize_text(raw.get("平台标签")),
                "客户凭证数量": normalize_integer(raw.get("客户凭证数量")),
                "币种": normalize_text(raw.get("币种")),
            }
        )
    return pd.DataFrame(output, columns=COLUMNS)
