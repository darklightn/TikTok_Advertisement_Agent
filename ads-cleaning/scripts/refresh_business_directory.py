#!/usr/bin/env python3
"""Refresh one accumulated shop directory from all authoritative batches."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True

from business_directory import BusinessDirectoryError, refresh_business_directory
from pipeline_runtime_config import load_pipeline_runtime_config


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--shop-id", required=True)
    parser.add_argument("--mapping", type=Path, default=root / "config" / "business-view-v1.json")
    args = parser.parse_args(argv)
    try:
        runtime = load_pipeline_runtime_config()
        result = refresh_business_directory(
            export_root=runtime["export_data_root"], cleaning_root=runtime["cleaning_data_root"],
            business_root=runtime["business_view_root"], shop_id=args.shop_id, mapping_path=args.mapping,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except BusinessDirectoryError as exc:
        print(json.dumps({"status": "failed", "code": exc.code, "message": str(exc)}, ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
