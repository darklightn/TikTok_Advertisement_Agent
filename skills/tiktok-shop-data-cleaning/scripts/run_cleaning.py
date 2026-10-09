from __future__ import annotations

import argparse
import importlib
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from common import CleaningContext, CleaningError


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = PROJECT_ROOT / "config" / "cleaning.yaml"


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("日期必须为 YYYY-MM-DD") from exc


def normalize_target(value: str) -> str:
    target = value.strip()
    if target.lower().endswith(".xlsx"):
        target = target[:-5]
    return target


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="生成 TikTok Shop 清洗表")
    parser.add_argument("--shop-root", required=True, type=Path, help="店铺根目录")
    parser.add_argument("--shop-id", help="当前绑定店铺的 TikTok Shop sellerId")
    parser.add_argument("--target", required=True, help="目标清洗表中文名称，可带 .xlsx")
    parser.add_argument("--start-date", type=parse_date, help="统计开始日期 YYYY-MM-DD")
    parser.add_argument("--end-date", type=parse_date, help="统计结束日期 YYYY-MM-DD")
    return parser


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("tables"), dict):
        raise CleaningError("INVALID_CONFIG", "cleaning.yaml 缺少 tables 配置")
    return data


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=False, default=str))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    target = normalize_target(args.target)
    try:
        config = load_config()
        table_config = config["tables"].get(target)
        if table_config is None:
            raise CleaningError("UNSUPPORTED_TARGET", f"尚未实现目标表：{target}")
        shop_id = args.shop_id.strip() if args.shop_id is not None else None
        if bool(table_config.get("requires_shop_id")) and not shop_id:
            raise CleaningError("MISSING_SHOP_ID", "该目标表必须提供 --shop-id")
        if bool(table_config.get("requires_period")):
            if args.start_date is None or args.end_date is None:
                raise CleaningError("MISSING_PERIOD", "该目标表必须同时提供 --start-date 和 --end-date")
            if args.start_date > args.end_date:
                raise CleaningError("INVALID_PERIOD", "统计开始日期不得晚于统计结束日期")
        elif args.start_date is not None or args.end_date is not None:
            if args.start_date is None or args.end_date is None:
                raise CleaningError("INCOMPLETE_PERIOD", "日期参数必须同时提供")

        from source_locator import locate_sources
        from upsert import upsert_and_write
        builder_name = str(table_config["builder"])
        builder_module = importlib.import_module(f"builders.{builder_name}")
        context = CleaningContext(
            shop_root=args.shop_root.resolve(),
            target=target,
            start_date=args.start_date,
            end_date=args.end_date,
            output_dir=args.shop_root.resolve() / "20_清洗数据",
            shop_id=shop_id,
        )
        sources = locate_sources(context, table_config)
        new_rows = builder_module.build(context, sources)
        output_path = context.output_dir / table_config["output"]
        result = upsert_and_write(new_rows, output_path, table_config)
        emit({"status": "success", "target": target, "output": str(output_path), **result})
        return 0
    except CleaningError as exc:
        emit({"status": "error", "code": exc.code, "target": target, "message": str(exc)})
        return 1
    except Exception as exc:
        emit({"status": "error", "code": "UNEXPECTED_ERROR", "target": target, "message": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
