#!/usr/bin/env python3
"""Build the post-cleaning campaign-creative to official-video association table."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from associations.creative_official_video import build_associations, write_associations
from cleaning.errors import CleaningError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign-creative-csv", type=Path, required=True)
    parser.add_argument("--official-video-csv", type=Path, required=True)
    parser.add_argument("--scope-contract", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        scope = json.loads(args.scope_contract.read_text(encoding="utf-8"))
        rows, qa = build_associations(args.campaign_creative_csv, args.official_video_csv, scope)
        print(json.dumps({"status": "success", **write_associations(rows, qa, args.output_dir), "qa_summary": qa}, ensure_ascii=False, indent=2))
        return 0
    except (CleaningError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "failed", "code": getattr(exc, "code", type(exc).__name__), "message": str(exc)}, ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
