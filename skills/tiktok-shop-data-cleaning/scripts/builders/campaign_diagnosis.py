from __future__ import annotations

import re
from datetime import date
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
    normalize_text,
    parse_json_object,
    parse_json_value,
    read_account_identity,
    read_rows,
    safe_divide,
)


DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
AVAILABLE_STATUSES = {"已探索", "探索中"}


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _plan_from_period_file(path_name: str, suffix: str) -> str:
    marker = f"__{suffix}.xlsx"
    if not path_name.endswith(marker):
        raise CleaningError("INVALID_SOURCE_NAME", f"原始文件名不符合精确区间规则：{path_name}")
    return path_name[: -len(marker)]


def _plan_and_product_from_creative(path_name: str, suffix: str, plan_names: list[str]) -> tuple[str, str]:
    end = f"__{suffix}.xlsx"
    for plan_name in sorted(plan_names, key=len, reverse=True):
        prefix = f"{plan_name}__"
        if path_name.startswith(prefix) and path_name.endswith(end):
            product_context = path_name[len(prefix) : -len(end)]
            if product_context:
                return plan_name, product_context
    raise CleaningError("INVALID_SOURCE_NAME", f"无法解析计划商品素材文件名：{path_name}")


def _single_matching_row(rows: list[dict[str, Any]], plan_id: str | None, plan_name: str, label: str) -> dict[str, Any]:
    by_id = [row for row in rows if plan_id is not None and normalize_id(row.get("campaign_id")) == plan_id]
    if len(by_id) == 1:
        return by_id[0]
    if len(by_id) > 1:
        raise CleaningError("DUPLICATE_SOURCE", f"计划{plan_name}的{label}存在多行")
    by_name = [row for row in rows if normalize_text(row.get("campaign_name")) == plan_name]
    if len(by_name) != 1:
        raise CleaningError("MISSING_SOURCE", f"计划{plan_name}无法唯一匹配{label}")
    return by_name[0]


def _latest_date_from_name(path_name: str) -> date:
    matches = DATE_RE.findall(path_name)
    if not matches:
        raise CleaningError("INVALID_SOURCE_NAME", f"文件名缺少日期：{path_name}")
    return date.fromisoformat(matches[-1])


def _replace_meta_placeholders(text: str, meta: dict[str, Any]) -> str:
    output = text
    for key, value in meta.items():
        if isinstance(value, (str, int, float)):
            output = output.replace("{" + str(key) + "}", str(value))
    return output


def _roi_recommendation(raw_items: Any) -> tuple[float | int | None, float | None, str | None]:
    items = parse_json_value(raw_items, "items_json")
    if not isinstance(items, list):
        raise CleaningError("INVALID_JSON", "items_json不是数组")
    candidates: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        content = _mapping(item.get("content"))
        meta = _mapping(content.get("meta"))
        fields = meta.get("to_update_fields")
        if isinstance(fields, list) and "roas_bid" in fields:
            candidates.append(content)
    if not candidates:
        return None, None, None
    if len(candidates) > 1:
        raise CleaningError("DATA_CONFLICT", "同一items文件存在多个ROI建议项")
    content = candidates[0]
    meta = _mapping(content.get("meta"))
    roas = normalize_money(meta.get("roas_bid"))
    percentile_raw = normalize_money(meta.get("compete_percentile"))
    percentile = None if percentile_raw is None else float(percentile_raw) / 100.0

    translations: dict[str, str] = {}
    starling = content.get("starling")
    if isinstance(starling, list):
        for item in starling:
            if isinstance(item, dict):
                name = normalize_text(item.get("name"))
                value = normalize_text(item.get("value"))
                if name is not None and value is not None:
                    translations[name] = value
    parts: list[str] = []
    for field in ("title", "content"):
        raw = normalize_text(content.get(field))
        if raw is None:
            continue
        rendered = translations.get(raw, raw)
        rendered = _replace_meta_placeholders(rendered, meta)
        if rendered:
            parts.append(rendered)
    return roas, percentile, "；".join(parts) or None


def _creative_key(raw: dict[str, Any], product_id: str, plan_id: str | None, plan_name: str) -> tuple[str, str, str]:
    plan_identity = plan_id or plan_name
    creative_type = normalize_text(raw.get("Creative type"))
    if creative_type is None:
        raise CleaningError("MISSING_KEY", "素材缺少Creative type")
    if creative_type.casefold() == "product card":
        return plan_identity, product_id, creative_type
    post_id = normalize_id(raw.get("Post ID"))
    if post_id is None:
        raise CleaningError("MISSING_KEY", "Video素材缺少Post ID")
    return plan_identity, product_id, post_id


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    columns = [
        "统计开始日期", "统计结束日期", "统计天数", "店铺ID", "店铺名称", "广告户ID", "广告户名称",
        "计划ID", "计划名称", "计划主状态", "计划状态", "优化状态", "当前优化模式", "当前视频选择模式",
        "当前新素材探索设置", "目标ROI", "当前日预算", "当前预算模式", "当前开始时间", "当前结束时间",
        "配置快照日期", "ROI建议快照日期", "平台建议ROI", "ROI竞争力百分位", "平台建议摘要", "广告成本",
        "日均广告成本", "广告展示量", "广告点击量", "广告CTR", "广告CPC", "广告CPM", "GMV Max SKU订单数",
        "GMV Max平均下单成本", "GMV Max总收入", "实际ROI", "推广商品数", "可用素材数", "有消耗素材数", "广告币种",
    ]
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "计划诊断必须提供日期范围")
    account_files = sources.files.get("advertiser_account_status", [])
    if len(account_files) != 1:
        raise CleaningError("MISSING_SOURCE", "计划诊断缺少广告账户状态")
    account = read_account_identity(account_files[0])
    performance_suffix = str(sources.metadata.get("performance_period_suffix") or "")
    creative_suffix = str(sources.metadata.get("creative_period_suffix") or "")
    plan_names = [str(value) for value in sources.metadata.get("plan_names", [])]

    config_by_plan: dict[str, list[dict[str, Any]]] = {}
    for path in sources.files.get("campaign_current_config", []):
        config_by_plan[path.name.split("__", 1)[0]] = read_rows(path)
    items_by_plan: dict[str, tuple[date, list[dict[str, Any]]]] = {}
    for path in sources.files.get("campaign_recommendation_items", []):
        plan = path.name.split("__items__", 1)[0]
        items_by_plan[plan] = (_latest_date_from_name(path.name), read_rows(path))
    products_by_plan: dict[str, list[dict[str, Any]]] = {}
    for path in sources.files.get("campaign_product_performance", []):
        plan = _plan_from_period_file(path.name, performance_suffix)
        products_by_plan.setdefault(plan, []).extend(read_rows(path))
    creatives_by_plan: dict[str, list[tuple[dict[str, Any], str]]] = {}
    for path in sources.files.get("campaign_product_creative_performance", []):
        plan, product_context = _plan_and_product_from_creative(path.name, creative_suffix, plan_names)
        for row in read_rows(path):
            creatives_by_plan.setdefault(plan, []).append((row, product_context))

    output: list[dict[str, Any]] = []
    for performance_path in sources.files.get("campaign_performance", []):
        plan_from_file = _plan_from_period_file(performance_path.name, performance_suffix)
        performance_rows = read_rows(performance_path)
        if len(performance_rows) != 1:
            raise CleaningError("DUPLICATE_SOURCE", f"计划{plan_from_file}的计划表现必须唯一一行")
        performance = performance_rows[0]
        plan_id = normalize_id(performance.get("campaign_id"))
        plan_name = normalize_text(performance.get("campaign_name")) or plan_from_file
        if plan_name != plan_from_file:
            raise CleaningError("IDENTITY_CONFLICT", f"计划表现文件名与行内计划名称不一致：{performance_path.name}")

        config_rows = config_by_plan.get(plan_name, [])
        config_row = _single_matching_row(config_rows, plan_id, plan_name, "当前配置")
        configuration = parse_json_object(config_row.get("configuration_json"), "configuration_json")
        ad_info = _mapping(configuration.get("ad_info"))

        if plan_name not in items_by_plan:
            raise CleaningError("MISSING_SOURCE", f"计划{plan_name}缺少GMV Max建议快照items文件")
        items_date, item_rows = items_by_plan[plan_name]
        if item_rows:
            item_row = _single_matching_row(item_rows, plan_id, plan_name, "建议快照items")
            suggested_roi, percentile, summary = _roi_recommendation(item_row.get("items_json"))
        else:
            suggested_roi, percentile, summary = None, None, None

        product_rows = products_by_plan.get(plan_name, [])
        product_ids = {normalize_id(row.get("Product ID")) for row in product_rows}
        product_ids.discard(None)
        product_name_to_ids: dict[str, set[str]] = {}
        for product in product_rows:
            product_name = normalize_text(product.get("商品名称"))
            product_id = normalize_id(product.get("Product ID"))
            if product_name is not None and product_id is not None:
                product_name_to_ids.setdefault(product_name, set()).add(product_id)

        creative_state: dict[tuple[str, str, str], dict[str, Any]] = {}
        for creative, product_context in creatives_by_plan.get(plan_name, []):
            product_id = normalize_id(creative.get("product_id"))
            if product_id is None:
                matched = product_name_to_ids.get(product_context, set())
                if len(matched) != 1:
                    raise CleaningError("MISSING_KEY", f"素材文件{product_context}无法唯一确定商品ID")
                product_id = next(iter(matched))
            key = _creative_key(creative, product_id, plan_id, plan_name)
            state = creative_state.setdefault(key, {"available": False, "cost": 0.0})
            if normalize_text(creative.get("Status")) in AVAILABLE_STATUSES:
                state["available"] = True
            cost = normalize_money(creative.get("成本"))
            if cost is not None:
                state["cost"] += float(cost)

        cost = normalize_money(performance.get("cost"))
        impressions = normalize_integer(performance.get("show_cnt"))
        clicks = normalize_integer(performance.get("click_cnt"))
        orders = normalize_integer(performance.get("onsite_roi2_shopping_sku"))
        revenue = normalize_money(performance.get("onsite_roi2_shopping_value"))
        day_count = (context.end_date - context.start_date).days + 1
        output.append(
            {
                "统计开始日期": context.start_date,
                "统计结束日期": context.end_date,
                "统计天数": day_count,
                "店铺ID": account["shop_id"],
                "店铺名称": context.shop_root.name,
                "广告户ID": account["advertiser_id"],
                "广告户名称": account["advertiser_name"],
                "计划ID": plan_id,
                "计划名称": plan_name,
                "计划主状态": normalize_placeholder(performance.get("campaign_primary_status")),
                "计划状态": normalize_placeholder(performance.get("campaign_status")),
                "优化状态": normalize_placeholder(performance.get("campaign_opt_status")),
                "当前优化模式": normalize_placeholder(performance.get("current_optimization_mode")),
                "当前视频选择模式": normalize_placeholder(ad_info.get("product_video_selection_type")),
                "当前新素材探索设置": normalize_placeholder(ad_info.get("shop_new_creative_exploration")),
                "目标ROI": normalize_money(ad_info.get("roas_bid")),
                "当前日预算": normalize_money(ad_info.get("budget")),
                "当前预算模式": normalize_placeholder(ad_info.get("budget_mode")),
                "当前开始时间": normalize_placeholder(ad_info.get("start_time")),
                "当前结束时间": normalize_placeholder(ad_info.get("end_time")),
                "配置快照日期": normalize_date(config_row.get("captured_date")),
                "ROI建议快照日期": items_date,
                "平台建议ROI": suggested_roi,
                "ROI竞争力百分位": percentile,
                "平台建议摘要": summary,
                "广告成本": cost,
                "日均广告成本": safe_divide(cost, day_count),
                "广告展示量": impressions,
                "广告点击量": clicks,
                "广告CTR": safe_divide(normalize_money(performance.get("ctr")), 100),
                "广告CPC": safe_divide(cost, clicks),
                "广告CPM": safe_divide(cost, impressions, 1000.0),
                "GMV Max SKU订单数": orders,
                "GMV Max平均下单成本": normalize_money(performance.get("cost_per_onsite_roi2_shopping_sku")),
                "GMV Max总收入": revenue,
                "实际ROI": normalize_money(performance.get("onsite_roi2_shopping")),
                "推广商品数": len(product_ids),
                "可用素材数": sum(1 for state in creative_state.values() if state["available"]),
                "有消耗素材数": sum(1 for state in creative_state.values() if state["cost"] > 0),
                "广告币种": normalize_text(performance.get("currency")),
            }
        )
    if not output:
        raise CleaningError("EMPTY_SOURCE", "计划诊断没有可生成的数据行")
    return pd.DataFrame(output, columns=columns)
