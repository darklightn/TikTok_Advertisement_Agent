#!/usr/bin/env python3
"""CLI facade for deterministic TikTok Shop cleaning."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

# Production Skills are deployed as source-only artifacts. Prevent direct CLI
# execution from depositing interpreter caches into the deployed Skill tree.
sys.dont_write_bytecode = True

from cleaning.contracts import COMMON_OUTPUT_FIELDS, order_columns, product_columns
from cleaning.errors import CleaningError
from cleaning.pipeline import clean, clean_logical_job
from cleaning.records import CLEANING_VERSION, _add_ad_calculations
from pipeline_runtime_config import load_pipeline_runtime_config, normalize_data_root


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).parents[1]
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest", type=Path)
    source.add_argument("--logical-export-job-id")
    parser.add_argument("--export-root", type=Path)
    parser.add_argument("--report-id", action="append", required=True)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--model", type=Path, default=root / "config" / "first-model-v1.json")
    parser.add_argument("--baseline", type=Path, default=root / "config" / "source-schema-baseline-v1.json")
    args = parser.parse_args(argv)
    try:
        runtime_config = None
        if args.output_root is None or (args.logical_export_job_id and args.export_root is None):
            runtime_config = load_pipeline_runtime_config()
        output_root = normalize_data_root(args.output_root, "cleaning_data_root") if args.output_root else runtime_config["cleaning_data_root"]
        resolution = {"cleaning_data_root": "explicit_cli_override" if args.output_root else "shared_runtime_config"}
        if args.logical_export_job_id:
            export_root = normalize_data_root(args.export_root, "export_data_root") if args.export_root else runtime_config["export_data_root"]
            resolution["export_data_root"] = "explicit_cli_override" if args.export_root else "shared_runtime_config"
            result = clean_logical_job(export_root, args.logical_export_job_id, args.report_id, output_root, args.model, args.baseline)
        else:
            if args.export_root is not None:
                raise CleaningError("export_root_not_applicable", "--export-root is only valid for logical job mode")
            result = clean(args.manifest, args.report_id, output_root, args.model, args.baseline)
        result = {**result, "runtime_root_resolution": resolution}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except CleaningError as exc:
        print(json.dumps({"status": "failed", "code": exc.code, "message": str(exc)}, ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
