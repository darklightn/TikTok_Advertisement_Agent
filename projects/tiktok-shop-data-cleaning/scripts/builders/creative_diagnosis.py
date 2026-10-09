from __future__ import annotations

from pathlib import Path
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
    read_account_identity,
    read_rows,
    safe_divide,
)


COLUMNS = [
    "统计开始日期", "统计结束日期", "店铺ID", "店铺名称", "广告户ID", "广告户名称", "计划ID", "计划名称",
    "商品ID", "商品名称", "Post ID", "素材标题", "TikTok账号", "素材类型", "素材来源", "素材探索状态",
    "素材探索结果", "授权类型", "授权状态", "预审状态", "发布时间", "广告成本", "成本占计划比",
    "GMV Max SKU订单数", "订单占计划比", "GMV Max平均下单成本", "GMV Max总收入", "收入占计划比",
    "实际ROI", "商品广告曝光量", "商品广告点击量", "商品广告点击率", "广告转化率", "2秒广告视频播放率",
    "6秒广告视频播放率", "25%广告视频播放率", "50%广告视频播放率", "75%广告视频播放率",
    "100%广告视频播放率", "广告币种",
]


def _plan_from_period(path: Path, suffix: str) -> str:
    marker = f"__{suffix}"
    if not path.stem.endswith(marker):
        raise CleaningError("INVALID_SOURCE_NAME", f"原始文件名不符合精确区间规则：{path.name}")
    plan = path.stem[: -len(marker)].strip()
    if not plan:
        raise CleaningError("INVALID_SOURCE_NAME", f"原始文件名缺少计划名称：{path.name}")
    return plan


def _creative_context(path: Path, suffix: str, plan_names: list[str]) -> tuple[str, str]:
    ending = f"__{suffix}"
    for plan_name in sorted(plan_names, key=len, reverse=True):
        prefix = f"{plan_name}__"
        if path.stem.startswith(prefix) and path.stem.endswith(ending):
            context = path.stem[len(prefix) : -len(ending)]
            if context:
                return plan_name, context
    raise CleaningError("INVALID_SOURCE_NAME", f"无法解析计划商品素材文件名：{path.name}")


def _hub_index(rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    index: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        video_id = normalize_id(row.get("Video ID"))
        product_id = normalize_id(row.get("Product ID"))
        if video_id is None or product_id is None:
            continue
        key = (video_id, product_id)
        if key in index:
            raise CleaningError("DUPLICATE_SOURCE", f"素材中心存在重复Video ID + Product ID：{key}")
        index[key] = row
    return index


def _first_text(primary: Any, fallback: Any) -> str | None:
    return normalize_text(primary) or normalize_text(fallback)


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "素材诊断必须提供日期范围")
    account_files = sources.files.get("advertiser_account_status", [])
    hub_files = sources.files.get("shop_creative_hub_video", [])
    if len(account_files) != 1 or len(hub_files) != 1:
        raise CleaningError("MISSING_SOURCE", "素材诊断缺少唯一账户快照或素材中心文件")
    account = read_account_identity(account_files[0])
    performance_suffix = str(sources.metadata.get("performance_period_suffix") or "")
    creative_suffix = str(sources.metadata.get("creative_period_suffix") or "")
    plan_names = [str(value) for value in sources.metadata.get("plan_names", [])]

    performance_by_plan: dict[str, dict[str, Any]] = {}
    for path in sources.files.get("campaign_performance", []):
        plan_name = _plan_from_period(path, performance_suffix)
        rows = read_rows(path)
        if len(rows) != 1 or plan_name in performance_by_plan:
            raise CleaningError("DUPLICATE_SOURCE", f"计划{plan_name}的计划表现必须唯一一行")
        performance_by_plan[plan_name] = rows[0]

    products_by_plan: dict[str, list[dict[str, Any]]] = {}
    for path in sources.files.get("campaign_product_performance", []):
        plan_name = _plan_from_period(path, performance_suffix)
        products_by_plan.setdefault(plan_name, []).extend(read_rows(path))

    hub = _hub_index(read_rows(hub_files[0]))
    output: list[dict[str, Any]] = []
    for path in sources.files.get("campaign_product_creative_performance", []):
        plan_name, product_context = _creative_context(path, creative_suffix, plan_names)
        performance = performance_by_plan.get(plan_name)
        if performance is None:
            raise CleaningError("MISSING_SOURCE", f"素材文件{path.name}无法匹配计划表现")
        plan_id = normalize_id(performance.get("campaign_id"))
        products = products_by_plan.get(plan_name, [])
        product_names_by_id: dict[str, str] = {}
        ids_by_name: dict[str, set[str]] = {}
        for product in products:
            product_id = normalize_id(product.get("Product ID"))
            product_name = normalize_text(product.get("商品名称"))
            if product_id is not None and product_name is not None:
                product_names_by_id[product_id] = product_name
                ids_by_name.setdefault(product_name, set()).add(product_id)

        for raw in read_rows(path):
            material_type = normalize_text(raw.get("Creative type"))
            is_card = material_type is not None and material_type.casefold() == "product card"
            product_id = normalize_id(raw.get("product_id"))
            if product_id is None:
                matches = ids_by_name.get(product_context, set())
                product_id = next(iter(matches)) if len(matches) == 1 else None
            product_name = product_names_by_id.get(product_id or "") or product_context
            post_id = None if is_card else normalize_id(raw.get("Post ID"))
            hub_row = {} if is_card or post_id is None or product_id is None else hub.get((post_id, product_id), {})
            cost = normalize_money(raw.get("成本"))
            orders = normalize_integer(raw.get("SKU 订单数"))
            revenue = normalize_money(raw.get("总收入"))
            impressions = normalize_integer(raw.get("Product ad impressions"))
            clicks = normalize_integer(raw.get("Product ad clicks"))
            row = {
                "统计开始日期": context.start_date,
                "统计结束日期": context.end_date,
                "店铺ID": account["shop_id"],
                "店铺名称": context.shop_root.name,
                "广告户ID": account["advertiser_id"],
                "广告户名称": account["advertiser_name"],
                "计划ID": plan_id,
                "计划名称": plan_name,
                "商品ID": product_id,
                "商品名称": product_name,
                "Post ID": post_id,
                "素材标题": None if is_card else _first_text(raw.get("Creative"), hub_row.get("视频标题")),
                "TikTok账号": None if is_card else _first_text(raw.get("TikTok account"), hub_row.get("Username")),
                "素材类型": material_type,
                "素材来源": None if is_card else _first_text(raw.get("Creative source"), hub_row.get("Video source")),
                "素材探索状态": normalize_text(raw.get("Status")),
                "素材探索结果": normalize_text(raw.get("Exploration secondary status")),
                "授权类型": None if is_card else normalize_text(hub_row.get("Authorization type")),
                "授权状态": None if is_card else normalize_text(hub_row.get("Authorization status")),
                "预审状态": None if is_card else normalize_text(hub_row.get("Pre-review status")),
                "发布时间": None if is_card else normalize_datetime(_first_text(raw.get("Time posted"), hub_row.get("Time posted"))),
                "广告成本": cost,
                "成本占计划比": safe_divide(cost, normalize_money(performance.get("cost"))),
                "GMV Max SKU订单数": orders,
                "订单占计划比": safe_divide(orders, normalize_integer(performance.get("onsite_roi2_shopping_sku"))),
                "GMV Max平均下单成本": normalize_money(raw.get("平均下单成本")),
                "GMV Max总收入": revenue,
                "收入占计划比": safe_divide(revenue, normalize_money(performance.get("onsite_roi2_shopping_value"))),
                "实际ROI": safe_divide(revenue, cost),
                "商品广告曝光量": impressions,
                "商品广告点击量": clicks,
                "商品广告点击率": normalize_money(raw.get("Product ad click rate")),
                "广告转化率": normalize_money(raw.get("Ad conversion rate")),
                "2秒广告视频播放率": None if is_card else normalize_money(raw.get("2-second ad video view rate")),
                "6秒广告视频播放率": None if is_card else normalize_money(raw.get("6-second ad video view rate")),
                "25%广告视频播放率": None if is_card else normalize_money(raw.get("25% ad video view rate")),
                "50%广告视频播放率": None if is_card else normalize_money(raw.get("50% ad video view rate")),
                "75%广告视频播放率": None if is_card else normalize_money(raw.get("75% ad video view rate")),
                "100%广告视频播放率": None if is_card else normalize_money(raw.get("100% ad video view rate")),
                "广告币种": normalize_text(raw.get("Currency")),
            }
            output.append(row)
    if not output:
        raise CleaningError("EMPTY_SOURCE", "素材诊断没有可生成的数据行")
    return pd.DataFrame(output, columns=COLUMNS)
