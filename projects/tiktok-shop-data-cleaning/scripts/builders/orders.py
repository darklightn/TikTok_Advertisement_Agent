from __future__ import annotations

from datetime import datetime
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
    "订单ID", "订单状态", "订单子状态", "取消/退货类型", "订单预售类型", "商品ID", "SKU ID", "商家SKU",
    "商品名称", "规格", "数量", "退货SKU数量", "SKU原价", "SKU折前小计", "平台折扣", "卖家折扣",
    "SKU折后小计", "折后运费", "原始运费", "卖家运费折扣", "平台运费折扣", "支付平台折扣", "税费",
    "订单金额", "订单退款金额", "创建时间", "支付时间", "备货完成时间", "发货时间", "签收时间", "取消时间",
    "支付至发货时长", "发货至签收时长", "订单总履约时长", "取消方", "取消原因", "履约类型", "仓库名称",
    "配送方式", "物流商", "支付方式", "商品类目", "订单渠道", "达人账号", "币种",
]

TEXT_FIELDS = {
    "订单状态": "Order Status", "订单子状态": "Order Substatus", "取消/退货类型": "Cancelation/Return Type",
    "订单预售类型": "Normal or Pre-order", "商家SKU": "Seller SKU", "商品名称": "Product Name", "规格": "Variation",
    "取消方": "Cancel By", "取消原因": "Cancel Reason", "履约类型": "Fulfillment Type", "仓库名称": "Warehouse Name",
    "配送方式": "Delivery Option", "物流商": "Shipping Provider Name", "支付方式": "Payment Method",
    "商品类目": "Product Category", "订单渠道": "Order Channel", "达人账号": "Creator Handle", "币种": "currency",
}
MONEY_FIELDS = {
    "SKU原价": "SKU Unit Original Price", "SKU折前小计": "SKU Subtotal Before Discount",
    "平台折扣": "SKU Platform Discount", "卖家折扣": "SKU Seller Discount", "SKU折后小计": "SKU Subtotal After Discount",
    "折后运费": "Shipping Fee After Discount", "原始运费": "Original Shipping Fee",
    "卖家运费折扣": "Shipping Fee Seller Discount", "平台运费折扣": "Shipping Fee Platform Discount",
    "支付平台折扣": "Payment platform discount", "税费": "Taxes", "订单金额": "Order Amount",
    "订单退款金额": "Order Refund Amount",
}
TIME_FIELDS = {
    "创建时间": "Created Time", "支付时间": "Paid Time", "备货完成时间": "RTS Time", "发货时间": "Shipped Time",
    "签收时间": "Delivered Time", "取消时间": "Cancelled Time",
}


def _hours(start: datetime | None, end: datetime | None) -> float | None:
    return None if start is None or end is None else (end - start).total_seconds() / 3600


def _sku_map(path) -> dict[str, str | None]:
    mapping: dict[str, str | None] = {}
    for row in read_rows(path):
        sku_id = normalize_id(row.get("sku_id"))
        if sku_id is None:
            continue
        product_id = normalize_id(row.get("product_id"))
        if sku_id in mapping and mapping[sku_id] != product_id:
            raise CleaningError("DATA_CONFLICT", f"SKU {sku_id}存在多个商品映射")
        mapping[sku_id] = product_id
    return mapping


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    order_files = sources.files.get("order_detail", [])
    sku_files = sources.files.get("sku_commercial_status", [])
    if len(order_files) != 1 or len(sku_files) != 1:
        raise CleaningError("MISSING_SOURCE", "订单经营明细需要唯一订单文件和SKU快照")
    product_by_sku = _sku_map(sku_files[0])
    output: list[dict[str, Any]] = []
    for raw in read_rows(order_files[0]):
        sku_id = normalize_id(raw.get("SKU ID"))
        times = {name: normalize_datetime(raw.get(source)) for name, source in TIME_FIELDS.items()}
        row: dict[str, Any] = {
            "订单ID": normalize_id(raw.get("Order ID")), "商品ID": product_by_sku.get(sku_id), "SKU ID": sku_id,
            "数量": normalize_integer(raw.get("Quantity")), "退货SKU数量": normalize_integer(raw.get("Sku Quantity of return")),
            **times,
        }
        row.update({name: normalize_text(raw.get(source)) for name, source in TEXT_FIELDS.items()})
        row.update({name: normalize_money(raw.get(source)) for name, source in MONEY_FIELDS.items()})
        row["支付至发货时长"] = _hours(times["支付时间"], times["发货时间"])
        row["发货至签收时长"] = _hours(times["发货时间"], times["签收时间"])
        row["订单总履约时长"] = _hours(times["支付时间"], times["签收时间"])
        output.append(row)
    return pd.DataFrame(output, columns=COLUMNS)
