from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from typing import Any

from common import CleaningContext, CleaningError, LocatedSources


DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _xlsx_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(path for path in directory.iterdir() if path.is_file() and path.suffix.lower() == ".xlsx" and not path.name.startswith("~$"))


def _csv_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(path for path in directory.iterdir() if path.is_file() and path.suffix.lower() == ".csv")


def _last_date(path: Path) -> date | None:
    matches = DATE_RE.findall(path.stem)
    if not matches:
        return None
    try:
        return date.fromisoformat(matches[-1])
    except ValueError:
        return None


def _latest_file(directory: Path, label: str) -> Path:
    candidates = [(captured, path) for path in _xlsx_files(directory) if (captured := _last_date(path)) is not None]
    if not candidates:
        raise CleaningError("MISSING_SOURCE", f"缺少{label}原始文件")
    return max(candidates, key=lambda item: (item[0], item[1].name))[1]


def _latest_prefixed_file(directory: Path, prefix: str, label: str) -> Path:
    candidates = [
        (captured, path)
        for path in _xlsx_files(directory)
        if path.stem.startswith(prefix) and (captured := _last_date(path)) is not None
    ]
    if not candidates:
        raise CleaningError("MISSING_SOURCE", f"缺少{label}原始文件")
    return max(candidates, key=lambda item: (item[0], item[1].name))[1]


def _period_suffix(start: date, end: date) -> str:
    return start.isoformat() if start == end else f"{start.isoformat()}_至_{end.isoformat()}"


def _plan_from_exact_file(path: Path, suffix: str) -> str | None:
    marker = f"__{suffix}"
    if not path.stem.endswith(marker):
        return None
    plan = path.stem[: -len(marker)].strip()
    return plan or None


def _latest_for_plan(directory: Path, plan_name: str, middle: str | None = None) -> Path | None:
    prefix = f"{plan_name}__" if middle is None else f"{plan_name}__{middle}__"
    candidates: list[tuple[date, Path]] = []
    for path in _xlsx_files(directory):
        if not path.stem.startswith(prefix):
            continue
        captured = _last_date(path)
        if captured is not None:
            candidates.append((captured, path))
    return max(candidates, key=lambda item: (item[0], item[1].name))[1] if candidates else None


def _locate_account(context: CleaningContext) -> Path:
    return _latest_file(context.shop_root / "广告户数据" / "广告账户状态", "广告账户状态")


def _locate_hourly(context: CleaningContext) -> LocatedSources:
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "计划小时表现必须提供日期范围")
    directory = context.shop_root / "计划数据" / "GMV Max 计划小时表现"
    hourly: list[Path] = []
    for path in _xlsx_files(directory):
        captured = _last_date(path)
        if captured is not None and context.start_date <= captured <= context.end_date:
            hourly.append(path)
    if not hourly:
        raise CleaningError("MISSING_SOURCE", "目标日期范围内没有GMV Max计划小时表现文件")
    return LocatedSources(
        files={"campaign_hourly": hourly, "advertiser_account_status": [_locate_account(context)]},
        metadata={},
    )


def _locate_campaign_diagnosis(context: CleaningContext) -> LocatedSources:
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", "计划诊断必须提供日期范围")
    performance_suffix = _period_suffix(context.start_date, context.end_date)
    creative_suffix = f"{context.start_date.isoformat()}_至_{context.end_date.isoformat()}"
    performance_dir = context.shop_root / "计划数据" / "GMV Max 计划表现"
    exact_performance: list[Path] = []
    plans: dict[str, Path] = {}
    for path in _xlsx_files(performance_dir):
        plan = _plan_from_exact_file(path, performance_suffix)
        if plan is not None:
            if plan in plans:
                raise CleaningError("DUPLICATE_SOURCE", f"计划{plan}存在多个精确区间计划表现文件")
            plans[plan] = path
            exact_performance.append(path)
    if not exact_performance:
        raise CleaningError("MISSING_SOURCE", "缺少精确统计区间的GMV Max计划表现文件")

    config_dir = context.shop_root / "计划数据" / "GMV Max 当前配置"
    items_dir = context.shop_root / "计划数据" / "GMV Max 建议快照"
    product_dir = context.shop_root / "计划数据" / "GMV Max 计划商品表现"
    creative_dir = context.shop_root / "计划数据" / "GMV Max 计划商品素材表现"
    configs: list[Path] = []
    items: list[Path] = []
    products: list[Path] = []
    creatives: list[Path] = []

    all_product_files = _xlsx_files(product_dir)
    all_creative_files = _xlsx_files(creative_dir)
    for plan_name in plans:
        config = _latest_for_plan(config_dir, plan_name)
        item_file = _latest_for_plan(items_dir, plan_name, "items")
        product_matches = [path for path in all_product_files if _plan_from_exact_file(path, performance_suffix) == plan_name]
        creative_matches = [
            path
            for path in all_creative_files
            if path.stem.startswith(f"{plan_name}__") and path.stem.endswith(f"__{creative_suffix}")
        ]
        if config is None:
            raise CleaningError("MISSING_SOURCE", f"计划{plan_name}缺少当前配置快照")
        if item_file is None:
            raise CleaningError("MISSING_SOURCE", f"计划{plan_name}缺少GMV Max建议快照items文件")
        if len(product_matches) != 1:
            raise CleaningError("MISSING_SOURCE", f"计划{plan_name}缺少唯一的精确区间计划商品表现文件")
        if not creative_matches:
            raise CleaningError("MISSING_SOURCE", f"计划{plan_name}缺少精确区间计划商品素材表现文件")
        configs.append(config)
        items.append(item_file)
        products.extend(product_matches)
        creatives.extend(creative_matches)

    return LocatedSources(
        files={
            "campaign_performance": exact_performance,
            "campaign_current_config": configs,
            "campaign_recommendation_items": items,
            "campaign_product_performance": products,
            "campaign_product_creative_performance": creatives,
            "advertiser_account_status": [_locate_account(context)],
        },
        metadata={
            "plan_names": list(plans),
            "performance_period_suffix": performance_suffix,
            "creative_period_suffix": creative_suffix,
        },
    )


def _require_period(context: CleaningContext, target: str) -> tuple[str, str]:
    if context.start_date is None or context.end_date is None:
        raise CleaningError("MISSING_PERIOD", f"{target}必须提供日期范围")
    return _period_suffix(context.start_date, context.end_date), f"{context.start_date.isoformat()}_至_{context.end_date.isoformat()}"


def _exact_plan_files(directory: Path, suffix: str) -> list[Path]:
    return [path for path in _xlsx_files(directory) if _plan_from_exact_file(path, suffix) is not None]


def _exact_named_file(directory: Path, stem: str, extension: str, label: str) -> Path:
    files = _xlsx_files(directory) if extension == ".xlsx" else _csv_files(directory)
    matches = [path for path in files if path.stem == stem]
    if len(matches) != 1:
        raise CleaningError("MISSING_SOURCE", f"缺少唯一的精确区间{label}文件")
    return matches[0]


def _prefixed_by_date(directory: Path, prefix: str) -> dict[date, Path]:
    result: dict[date, Path] = {}
    for path in _xlsx_files(directory):
        if not path.stem.startswith(prefix):
            continue
        captured = _last_date(path)
        if captured is None:
            continue
        if captured in result:
            raise CleaningError("DUPLICATE_SOURCE", f"{captured.isoformat()}存在多个{prefix}快照")
        result[captured] = path
    return result


def _cost_file(context: CleaningContext) -> Path:
    path = context.shop_root / "15_人工录入" / "成本表.xlsx"
    if not path.is_file():
        raise CleaningError("MISSING_SOURCE", "缺少成本表.xlsx")
    return path


def _locate_sku_inventory(context: CleaningContext) -> LocatedSources:
    commercial = context.shop_root / "店铺数据" / "商品与SKU商业状态快照"
    products = _prefixed_by_date(commercial, "products__")
    skus = _prefixed_by_date(commercial, "skus__")
    inventory = {
        captured: path
        for path in _xlsx_files(context.shop_root / "店铺数据" / "库存快照")
        if (captured := _last_date(path)) is not None
    }
    common_dates = set(products) & set(skus) & set(inventory)
    if not common_dates:
        raise CleaningError("MISSING_SOURCE", "缺少products、skus与库存的可组合共同快照")
    snapshot_date = max(common_dates)
    return LocatedSources(
        files={
            "product_status_products": [products[snapshot_date]],
            "product_status_skus": [skus[snapshot_date]],
            "inventory_snapshot": [inventory[snapshot_date]],
            "cost_table": [_cost_file(context)],
        },
        metadata={"snapshot_date": snapshot_date},
    )


def _locate_product_diagnosis(context: CleaningContext) -> LocatedSources:
    performance_suffix, range_suffix = _require_period(context, "商品经营诊断")
    commercial = context.shop_root / "店铺数据" / "商品与SKU商业状态快照"
    products = _prefixed_by_date(commercial, "products__")
    skus = _prefixed_by_date(commercial, "skus__")
    common_dates = set(products) & set(skus)
    if not common_dates:
        raise CleaningError("MISSING_SOURCE", "缺少products与skus的共同商业状态快照")
    commercial_date = max(common_dates)
    inventory_file = _latest_file(context.shop_root / "店铺数据" / "库存快照", "库存快照")
    inventory_date = _last_date(inventory_file)
    product_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划商品表现", performance_suffix)
    creative_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划商品素材表现", range_suffix)
    if not product_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划商品表现文件")
    if not creative_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划商品素材表现文件")
    return LocatedSources(
        files={
            "product_analytics": [_exact_named_file(context.shop_root / "店铺数据" / "商品分析表现", range_suffix, ".xlsx", "商品分析表现")],
            "product_status_products": [products[commercial_date]],
            "product_status_skus": [skus[commercial_date]],
            "inventory_snapshot": [inventory_file],
            "campaign_product_performance": product_files,
            "campaign_product_creative_performance": creative_files,
            "order_detail": [_exact_named_file(context.shop_root / "店铺数据" / "订单明细", range_suffix, ".csv", "订单明细")],
            "rating_detail": [_exact_named_file(context.shop_root / "店铺数据" / "商品评价", range_suffix, ".csv", "商品评价")],
            "cost_table": [_cost_file(context)],
        },
        metadata={
            "commercial_snapshot_date": commercial_date,
            "inventory_snapshot_date": inventory_date,
            "performance_period_suffix": performance_suffix,
            "creative_period_suffix": range_suffix,
        },
    )


def _locate_shop_diagnosis(context: CleaningContext) -> LocatedSources:
    performance_suffix, range_suffix = _require_period(context, "店铺诊断")
    products_file = _latest_prefixed_file(
        context.shop_root / "店铺数据" / "商品与SKU商业状态快照", "products__", "products商业状态快照"
    )
    inventory_file = _latest_file(context.shop_root / "店铺数据" / "库存快照", "库存快照")
    health_file = _latest_file(context.shop_root / "店铺数据" / "店铺健康快照", "店铺健康快照")
    fulfillment_file = _latest_file(context.shop_root / "店铺数据" / "履约表现快照", "履约表现快照")
    overview_files = _exact_plan_files(context.shop_root / "广告户数据" / "GMV Max 计划总览", range_suffix)
    performance_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划表现", performance_suffix)
    if len(overview_files) != 1:
        raise CleaningError("MISSING_SOURCE", "缺少唯一的精确区间GMV Max计划总览文件")
    if not performance_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划表现文件")
    return LocatedSources(
        files={
            "product_analytics": [_exact_named_file(context.shop_root / "店铺数据" / "商品分析表现", range_suffix, ".xlsx", "商品分析表现")],
            "order_detail": [_exact_named_file(context.shop_root / "店铺数据" / "订单明细", range_suffix, ".csv", "订单明细")],
            "advertiser_overview": overview_files,
            "campaign_performance": performance_files,
            "product_status_products": [products_file],
            "inventory_snapshot": [inventory_file],
            "shop_health_snapshot": [health_file],
            "fulfillment_snapshot": [fulfillment_file],
        },
        metadata={
            "products_snapshot_date": _last_date(products_file),
            "inventory_snapshot_date": _last_date(inventory_file),
            "health_snapshot_date": _last_date(health_file),
            "fulfillment_snapshot_date": _last_date(fulfillment_file),
        },
    )


def _locate_advertiser_diagnosis(context: CleaningContext) -> LocatedSources:
    performance_suffix, range_suffix = _require_period(context, "广告户诊断")
    overview_files = _exact_plan_files(context.shop_root / "广告户数据" / "GMV Max 计划总览", range_suffix)
    performance_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划表现", performance_suffix)
    if len(overview_files) != 1:
        raise CleaningError("MISSING_SOURCE", "缺少唯一的精确区间GMV Max计划总览文件")
    if not performance_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划表现文件")
    return LocatedSources(
        files={
            "advertiser_overview": overview_files,
            "campaign_performance": performance_files,
            "advertiser_account_status": [_locate_account(context)],
        },
        metadata={"performance_period_suffix": performance_suffix, "range_period_suffix": range_suffix},
    )


def _locate_creative_diagnosis(context: CleaningContext) -> LocatedSources:
    performance_suffix, range_suffix = _require_period(context, "素材诊断")
    performance_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划表现", performance_suffix)
    product_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划商品表现", performance_suffix)
    creative_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划商品素材表现", range_suffix)
    hub_files = [
        path
        for path in _xlsx_files(context.shop_root / "店铺数据" / "店铺素材中心视频")
        if path.stem == range_suffix
    ]
    if not performance_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划表现文件")
    if not product_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划商品表现文件")
    if not creative_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划商品素材表现文件")
    if len(hub_files) != 1:
        raise CleaningError("MISSING_SOURCE", "缺少唯一的精确区间店铺素材中心视频文件")
    plan_names = [_plan_from_exact_file(path, performance_suffix) for path in performance_files]
    return LocatedSources(
        files={
            "campaign_product_creative_performance": creative_files,
            "shop_creative_hub_video": hub_files,
            "campaign_performance": performance_files,
            "campaign_product_performance": product_files,
            "advertiser_account_status": [_locate_account(context)],
        },
        metadata={
            "plan_names": [name for name in plan_names if name is not None],
            "performance_period_suffix": performance_suffix,
            "creative_period_suffix": range_suffix,
        },
    )


def _locate_config_history(context: CleaningContext) -> LocatedSources:
    directory = context.shop_root / "计划数据" / "GMV Max 当前配置"
    latest: dict[str, tuple[date, Path]] = {}
    for path in _xlsx_files(directory):
        captured = _last_date(path)
        if captured is None:
            continue
        plan_name = _plan_from_exact_file(path, captured.isoformat())
        if plan_name is None:
            continue
        candidate = (captured, path)
        if plan_name not in latest or (captured, path.name) > (latest[plan_name][0], latest[plan_name][1].name):
            latest[plan_name] = candidate
    if not latest:
        raise CleaningError("MISSING_SOURCE", "缺少有效的GMV Max当前配置文件")
    return LocatedSources(
        files={
            "campaign_current_config": [item[1] for item in latest.values()],
            "advertiser_account_status": [_locate_account(context)],
        },
        metadata={},
    )


def _locate_campaign_changes(context: CleaningContext) -> LocatedSources:
    _, range_suffix = _require_period(context, "计划变更记录")
    change_files = _exact_plan_files(context.shop_root / "计划数据" / "GMV Max 计划变更记录", range_suffix)
    if not change_files:
        raise CleaningError("MISSING_SOURCE", "缺少精确区间GMV Max计划变更记录文件")
    return LocatedSources(
        files={
            "campaign_change_log": change_files,
            "advertiser_account_status": [_locate_account(context)],
        },
        metadata={"range_period_suffix": range_suffix},
    )


def _locate_ratings(context: CleaningContext) -> LocatedSources:
    _, range_suffix = _require_period(context, "商品评价明细")
    matches = [path for path in _csv_files(context.shop_root / "店铺数据" / "商品评价") if path.stem == range_suffix]
    if len(matches) != 1:
        raise CleaningError("MISSING_SOURCE", "缺少唯一的精确区间商品评价文件")
    return LocatedSources(files={"rating_detail": matches}, metadata={})


def _locate_promotions(context: CleaningContext) -> LocatedSources:
    _, range_suffix = _require_period(context, "营销活动明细")
    matches = [path for path in _xlsx_files(context.shop_root / "店铺数据" / "营销活动表现") if path.stem == range_suffix]
    if len(matches) != 1:
        raise CleaningError("MISSING_SOURCE", "缺少唯一的精确区间营销活动表现文件")
    return LocatedSources(files={"promotion_performance": matches}, metadata={})


def _locate_orders(context: CleaningContext) -> LocatedSources:
    _, range_suffix = _require_period(context, "订单经营明细")
    order_matches = [path for path in _csv_files(context.shop_root / "店铺数据" / "订单明细") if path.stem == range_suffix]
    if len(order_matches) != 1:
        raise CleaningError("MISSING_SOURCE", "缺少唯一的精确区间订单明细文件")
    sku_file = _latest_prefixed_file(
        context.shop_root / "店铺数据" / "商品与SKU商业状态快照", "skus__", "SKU商业状态快照"
    )
    return LocatedSources(files={"order_detail": order_matches, "sku_commercial_status": [sku_file]}, metadata={})


def _locate_refunds(context: CleaningContext) -> LocatedSources:
    refund_file = _latest_file(context.shop_root / "店铺数据" / "退货退款快照", "退货退款快照")
    order_files = _csv_files(context.shop_root / "店铺数据" / "订单明细")
    if not order_files:
        raise CleaningError("MISSING_SOURCE", "缺少订单历史文件")
    return LocatedSources(files={"refund_snapshot": [refund_file], "order_history": order_files}, metadata={})


def _locate_shop_health(context: CleaningContext) -> LocatedSources:
    path = _latest_file(context.shop_root / "店铺数据" / "店铺健康快照", "店铺健康快照")
    return LocatedSources(files={"shop_health_snapshot": [path]}, metadata={})


def _locate_fulfillment(context: CleaningContext) -> LocatedSources:
    path = _latest_file(context.shop_root / "店铺数据" / "履约表现快照", "履约表现快照")
    return LocatedSources(files={"fulfillment_snapshot": [path]}, metadata={})


def locate_sources(context: CleaningContext, table_config: dict[str, Any]) -> LocatedSources:
    if not context.shop_root.is_dir():
        raise CleaningError("MISSING_SHOP_ROOT", f"店铺根目录不存在：{context.shop_root}")
    builder = table_config.get("builder")
    if builder == "advertiser_status":
        return LocatedSources(files={"advertiser_account_status": [_locate_account(context)]}, metadata={})
    if builder == "campaign_hourly":
        return _locate_hourly(context)
    if builder == "campaign_diagnosis":
        return _locate_campaign_diagnosis(context)
    if builder == "advertiser_diagnosis":
        return _locate_advertiser_diagnosis(context)
    if builder == "creative_diagnosis":
        return _locate_creative_diagnosis(context)
    if builder == "campaign_config_history":
        return _locate_config_history(context)
    if builder == "campaign_changes":
        return _locate_campaign_changes(context)
    if builder == "ratings":
        return _locate_ratings(context)
    if builder == "promotions":
        return _locate_promotions(context)
    if builder == "orders":
        return _locate_orders(context)
    if builder == "refunds":
        return _locate_refunds(context)
    if builder == "shop_health":
        return _locate_shop_health(context)
    if builder == "fulfillment":
        return _locate_fulfillment(context)
    if builder == "sku_inventory":
        return _locate_sku_inventory(context)
    if builder == "product_diagnosis":
        return _locate_product_diagnosis(context)
    if builder == "shop_diagnosis":
        return _locate_shop_diagnosis(context)
    raise CleaningError("UNSUPPORTED_TARGET", f"尚未实现Builder：{builder}")
