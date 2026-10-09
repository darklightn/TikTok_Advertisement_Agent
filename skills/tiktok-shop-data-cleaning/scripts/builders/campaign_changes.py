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
    normalize_text,
    parse_json_object,
    read_account_identity,
    read_rows,
)


COLUMNS = [
    "变更时间", "店铺ID", "广告户ID", "计划ID", "计划名称", "变更ID", "对象类型", "对象ID",
    "操作人", "变更摘要", "变更详情", "广告币种",
]


def _plan_from_file(path: Path, suffix: str) -> str:
    marker = f"__{suffix}"
    if not path.stem.endswith(marker):
        raise CleaningError("INVALID_SOURCE_NAME", f"变更文件名不符合精确区间规则：{path.name}")
    plan = path.stem[: -len(marker)].strip()
    if not plan:
        raise CleaningError("INVALID_SOURCE_NAME", f"变更文件名缺少计划名称：{path.name}")
    return plan


def _detail_text(details: Any, field: str) -> str | None:
    if not isinstance(details, list):
        return None
    values = [normalize_text(item.get(field)) for item in details if isinstance(item, dict)]
    return "；".join(value for value in values if value is not None) or None


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    account_files = sources.files.get("advertiser_account_status", [])
    if len(account_files) != 1:
        raise CleaningError("MISSING_SOURCE", "计划变更记录缺少唯一广告账户状态")
    account = read_account_identity(account_files[0])
    suffix = str(sources.metadata.get("range_period_suffix") or "")
    output: list[dict[str, Any]] = []
    for path in sources.files.get("campaign_change_log", []):
        plan_name = _plan_from_file(path, suffix)
        for raw in read_rows(path):
            record = parse_json_object(raw.get("change_record_json"), "change_record_json")
            details = record.get("activity_details")
            output.append(
                {
                    "变更时间": normalize_datetime(record.get("opt_time")),
                    "店铺ID": account["shop_id"],
                    "广告户ID": account["advertiser_id"],
                    "计划ID": normalize_id(raw.get("campaign_id")),
                    "计划名称": plan_name,
                    "变更ID": normalize_id(raw.get("change_id")) or normalize_id(record.get("id")),
                    "对象类型": normalize_text(record.get("object_type")),
                    "对象ID": normalize_id(record.get("object_id")),
                    "操作人": normalize_text(record.get("user")),
                    "变更摘要": _detail_text(details, "value"),
                    "变更详情": _detail_text(details, "hover"),
                    "广告币种": normalize_text(raw.get("currency")),
                }
            )
    return pd.DataFrame(output, columns=COLUMNS)
