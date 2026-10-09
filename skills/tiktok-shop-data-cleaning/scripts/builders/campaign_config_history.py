from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_date,
    normalize_datetime,
    normalize_id,
    normalize_money,
    normalize_placeholder,
    normalize_text,
    parse_json_object,
    read_account_identity,
    read_rows,
)


DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
COLUMNS = [
    "采集日期", "店铺ID", "广告户ID", "计划ID", "计划名称", "目标ROI", "日预算", "预算模式", "优化模式",
    "自动预算调整开关", "当前有效预算", "促销日设置开关", "促销日ROI", "促销日日预算", "开始时间",
    "结束时间", "推广商品数", "推广商品ID列表", "视频选择模式", "新素材探索设置", "投放国家", "广告币种",
]


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _date_from_name(path: Path) -> date:
    matches = DATE_RE.findall(path.stem)
    if not matches:
        raise CleaningError("INVALID_SOURCE_NAME", f"配置文件名缺少采集日期：{path.name}")
    return date.fromisoformat(matches[-1])


def _boolean(value: Any, field: str) -> bool | None:
    value = normalize_placeholder(value)
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value.strip().casefold() in {"true", "false"}:
        return value.strip().casefold() == "true"
    raise CleaningError("INVALID_BOOLEAN", f"{field}无法解析为布尔值")


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    account_files = sources.files.get("advertiser_account_status", [])
    if len(account_files) != 1:
        raise CleaningError("MISSING_SOURCE", "计划配置历史缺少唯一广告账户状态")
    account = read_account_identity(account_files[0])
    output: list[dict[str, Any]] = []
    for path in sources.files.get("campaign_current_config", []):
        rows = read_rows(path)
        if len(rows) != 1:
            raise CleaningError("DUPLICATE_SOURCE", f"配置文件必须唯一一行：{path.name}")
        raw = rows[0]
        configuration = parse_json_object(raw.get("configuration_json"), "configuration_json")
        ad_info = _mapping(configuration.get("ad_info"))
        campaign_info = _mapping(configuration.get("campaign_info"))
        file_date = _date_from_name(path)
        content_date = normalize_date(raw.get("captured_date"))
        if content_date is not None and content_date != file_date:
            raise CleaningError("DATE_CONFLICT", f"配置文件名与内容采集日期冲突：{path.name}")
        plan_id = normalize_id(raw.get("campaign_id")) or normalize_id(campaign_info.get("campaign_id"))
        plan_name = normalize_text(raw.get("campaign_name")) or normalize_text(campaign_info.get("campaign_name"))
        budget_adjust = _mapping(ad_info.get("gmax_budget_adjust_setting"))
        promotion = _mapping(ad_info.get("promotion_days_setting"))
        product_ids = {
            product_id
            for item in ad_info.get("product_list", [])
            if isinstance(item, dict) and (product_id := normalize_id(item.get("spu_id"))) is not None
        } if isinstance(ad_info.get("product_list"), list) else set()
        output.append(
            {
                "采集日期": content_date or file_date,
                "店铺ID": account["shop_id"],
                "广告户ID": account["advertiser_id"],
                "计划ID": plan_id,
                "计划名称": plan_name,
                "目标ROI": normalize_money(ad_info.get("roas_bid")),
                "日预算": normalize_money(ad_info.get("budget")),
                "预算模式": normalize_placeholder(ad_info.get("budget_mode")),
                "优化模式": normalize_placeholder(campaign_info.get("gmv_roi_mode")),
                "自动预算调整开关": _boolean(budget_adjust.get("auto_budget_switch"), "auto_budget_switch"),
                "当前有效预算": normalize_money(budget_adjust.get("effective_budget")),
                "促销日设置开关": _boolean(promotion.get("is_enable"), "is_enable"),
                "促销日ROI": normalize_money(promotion.get("adjusted_roas_bid")),
                "促销日日预算": normalize_money(promotion.get("adjusted_budget")),
                "开始时间": normalize_datetime(ad_info.get("start_time")),
                "结束时间": normalize_datetime(ad_info.get("end_time")),
                "推广商品数": len(product_ids),
                "推广商品ID列表": ";".join(sorted(product_ids)),
                "视频选择模式": normalize_placeholder(ad_info.get("product_video_selection_type")),
                "新素材探索设置": normalize_placeholder(ad_info.get("shop_new_creative_exploration")),
                "投放国家": normalize_text(ad_info.get("country")),
                "广告币种": normalize_text(raw.get("currency")),
            }
        )
    if not output:
        raise CleaningError("EMPTY_SOURCE", "计划配置历史没有可生成的数据行")
    return pd.DataFrame(output, columns=COLUMNS)
