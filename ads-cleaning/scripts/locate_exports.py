#!/usr/bin/env python3
"""Locate and integrity-check exported datasets from immutable batch manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

# Keep deployed Skills source-only when this entry point imports local modules.
sys.dont_write_bytecode = True

from cleaning.errors import CleaningError
from pipeline_runtime_config import load_pipeline_runtime_config, normalize_data_root

SCHEMA = "export_batch_manifest_v3"
BINDING_SCHEMA = "hermes_recent_export_v3"
MODES = {"date_range", "latest_snapshot", "all_snapshots", "recent_batch"}
ALLOWED_FIELDS = {
    "mode", "shop_alias", "report_ids", "start_date", "end_date",
    "advertiser_id", "advertiser_name",
}


class LocatorError(Exception):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def _nonempty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LocatorError("invalid_intent", f"{field} must be a non-empty string")
    return value.strip()


def normalize_intent(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise LocatorError("invalid_intent", "intent must be a JSON object")
    unknown = sorted(set(raw) - ALLOWED_FIELDS)
    if unknown:
        raise LocatorError("invalid_intent", "intent contains unknown fields", unknown)
    mode = _nonempty(raw.get("mode"), "mode")
    if mode not in MODES:
        raise LocatorError("invalid_intent", f"unsupported mode: {mode}")
    reports = raw.get("report_ids")
    if reports is None and mode == "recent_batch":
        report_ids = []
    else:
        if not isinstance(reports, list) or not reports:
            raise LocatorError("invalid_intent", "report_ids must be a non-empty array")
        report_ids = [_nonempty(item, "report_ids[]") for item in reports]
        if len(set(report_ids)) != len(report_ids):
            raise LocatorError("invalid_intent", "report_ids must not contain duplicates")
    result: dict[str, Any] = {"mode": mode, "report_ids": report_ids}
    if mode != "recent_batch" or raw.get("shop_alias") is not None:
        result["shop_alias"] = _nonempty(raw.get("shop_alias"), "shop_alias")
    if mode == "date_range":
        for field in ("start_date", "end_date"):
            value = _nonempty(raw.get(field), field)
            try:
                date.fromisoformat(value)
            except ValueError as exc:
                raise LocatorError("invalid_intent", f"{field} must use YYYY-MM-DD") from exc
            result[field] = value
        if result["start_date"] > result["end_date"]:
            raise LocatorError("invalid_intent", "start_date must not exceed end_date")
    elif raw.get("start_date") is not None or raw.get("end_date") is not None:
        raise LocatorError("invalid_intent", "date fields are only valid for date_range")
    advertiser_fields = ("advertiser_id", "advertiser_name")
    if mode in {"latest_snapshot", "all_snapshots"} and any(raw.get(k) is not None for k in advertiser_fields):
        raise LocatorError("invalid_intent", "advertiser filters are not valid for snapshot modes")
    for field in advertiser_fields:
        if raw.get(field) is not None:
            result[field] = _nonempty(raw[field], field)
    return result


def _read_json(path: Path, code: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LocatorError(code, f"cannot read valid JSON: {path}") from exc
    if not isinstance(value, dict):
        raise LocatorError(code, f"JSON root must be an object: {path}")
    return value


def _manifest_identity(manifest: dict[str, Any]) -> str:
    return str(manifest.get("export_batch_id") or "")


def _validate_shop_time_context(manifest: dict[str, Any], path: Path) -> None:
    shop = manifest.get("shop") or {}
    region = shop.get("shop_region")
    timezone = shop.get("business_timezone")
    source = shop.get("business_timezone_source")
    observed_at = shop.get("business_timezone_observed_at")
    if not isinstance(shop.get("seller_id"), str) or not shop["seller_id"].strip():
        raise LocatorError("invalid_manifest", f"Manifest is missing Seller identity: {path}")
    if not isinstance(region, str) or not re.fullmatch(r"[A-Z]{2}", region):
        raise LocatorError("invalid_manifest", f"Manifest shop region is invalid: {path}")
    if not isinstance(timezone, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9._+-]*(?:/[A-Za-z0-9._+-]+)+", timezone):
        raise LocatorError("invalid_manifest", f"Manifest business timezone is invalid: {path}")
    if source != "official_seller_common_get_current_seller":
        raise LocatorError("invalid_manifest", f"Manifest business timezone source is invalid: {path}")
    try:
        parsed = datetime.fromisoformat(str(observed_at).replace("Z", "+00:00"))
    except ValueError as exc:
        raise LocatorError("invalid_manifest", f"Manifest timezone observation time is invalid: {path}") from exc
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise LocatorError("invalid_manifest", f"Manifest timezone observation time is not UTC: {path}")


def _load_manifest(path: Path) -> dict[str, Any]:
    manifest = _read_json(path, "invalid_manifest")
    schema = manifest.get("schema_version")
    if schema != SCHEMA:
        raise LocatorError("invalid_manifest", f"Manifest schema is unsupported: {path}")
    if manifest.get("batch_status") not in {"success", "partial"} or path.name != "manifest.json":
        raise LocatorError("invalid_manifest", f"Manifest is not a usable {SCHEMA}: {path}")
    batch_id = _manifest_identity(manifest)
    if not batch_id or path.parent.name != batch_id:
        raise LocatorError("invalid_manifest", f"Manifest filename and export_batch_id disagree: {path}")
    _validate_shop_time_context(manifest, path)
    manifest["_manifest_path"] = str(path.resolve())
    return manifest


def _successful_reports(manifest: dict[str, Any], report_ids: list[str], semantics: str | None = None) -> list[dict[str, Any]] | None:
    reports = manifest.get("reports")
    if not isinstance(reports, list):
        return None
    selected = []
    for report_id in report_ids:
        matches = [r for r in reports if isinstance(r, dict) and r.get("report_id") == report_id and r.get("status") == "success"]
        if len(matches) != 1 or (semantics and matches[0].get("date_semantics") != semantics):
            return None
        selected.append(matches[0])
    return selected


def _advertiser_matches(manifest: dict[str, Any], intent: dict[str, Any]) -> bool:
    advertiser = manifest.get("selected_advertiser") or {}
    return all(advertiser.get(field) == intent[field] for field in ("advertiser_id", "advertiser_name") if field in intent)


def _requires_advertiser(candidates: list[tuple[dict[str, Any], list[dict[str, Any]]]]) -> bool:
    return any(report.get("owner_type") == "advertiser" for _, reports in candidates for report in reports)


def _stable_latest(candidates: list[tuple[dict[str, Any], list[dict[str, Any]]]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    ordered = sorted(candidates, key=lambda pair: str(pair[0].get("export_batch_id") or ""))
    ordered.sort(key=lambda pair: str(pair[0].get("published_at_utc") or pair[0].get("created_at") or ""), reverse=True)
    return ordered[0]


def _validate_files(manifest: dict[str, Any], reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for report in reports:
        files = []
        for artifact in manifest.get("artifacts") or []:
            if not isinstance(artifact, dict) or artifact.get("report_id") != report.get("report_id"):
                continue
            files.append({**artifact, "path": str(Path(manifest["_manifest_path"]).parent.joinpath(*artifact["relative_path"].split("/")))})
        if not isinstance(files, list) or not files:
            raise LocatorError("invalid_files", f"report has no files: {report.get('report_id')}")
        checked = []
        for item in files:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("sha256"), str):
                raise LocatorError("invalid_files", f"file metadata is incomplete: {report.get('report_id')}")
            path = Path(item["path"])
            if not path.is_file():
                raise LocatorError("file_missing", f"exported file is missing: {path}")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest.lower() != item["sha256"].lower():
                raise LocatorError("hash_mismatch", f"exported file hash changed: {path}")
            checked.append(dict(item))
        output.append({
            "report_id": report["report_id"],
            "date_semantics": report.get("date_semantics"),
            "owner_type": report.get("owner_type"),
            "owner_id": report.get("owner_id"),
            "owner_name": report.get("owner_name"),
            "captured_at": report.get("captured_at"),
            "files": checked,
        })
    return output


def _result_for(manifest: dict[str, Any], reports: list[dict[str, Any]], equivalent_batch_ids: list[str] | None = None) -> dict[str, Any]:
    result = {
        "export_batch_id": manifest["export_batch_id"],
        "manifest_path": manifest["_manifest_path"],
        "shop": manifest.get("shop"),
        "selected_advertiser": manifest.get("selected_advertiser"),
        "request": manifest.get("request"),
        "reports": _validate_files(manifest, reports),
    }
    if equivalent_batch_ids and len(equivalent_batch_ids) > 1:
        result["equivalent_export_batch_ids"] = equivalent_batch_ids
    return result


def _load_all(export_root: Path) -> list[dict[str, Any]]:
    batches = export_root / "batches"
    if not batches.is_dir():
        return []
    manifests = []
    for path in sorted(batches.glob("*/manifest.json")):
        try:
            manifests.append(_load_manifest(path))
        except LocatorError:
            continue
    return manifests


def _choice(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        "export_batch_id": manifest.get("export_batch_id"),
        "created_at": manifest.get("published_at_utc") or manifest.get("created_at"),
        "shop_alias": (manifest.get("shop") or {}).get("shop_alias"),
        "selected_advertiser": manifest.get("selected_advertiser"),
        "request": manifest.get("request"),
    }


def locate(
    intent: dict[str, Any],
    export_root: Path,
    chat_id: str | None = None,
) -> dict[str, Any]:
    mode, report_ids = intent["mode"], intent["report_ids"]
    if mode == "recent_batch":
        if not chat_id:
            raise LocatorError("recent_binding_required", "recent_batch requires --chat-id")
        key = hashlib.sha256(chat_id.encode("utf-8")).hexdigest()
        binding_path = export_root / "_system" / "recent-bindings" / f"{key}.json"
        if not binding_path.is_file():
            return {"status": "missing", "code": "recent_binding_missing", "message": "当前会话没有可用的最近成功导出批次。"}
        binding = _read_json(binding_path, "invalid_binding")
        if binding.get("schema_version") != BINDING_SCHEMA or binding.get("chat_id") != chat_id:
            raise LocatorError("invalid_binding", f"recent binding is invalid: {binding_path}")
        job_id = str(binding.get("logical_export_job_id") or "")
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", job_id, re.I):
            raise LocatorError("invalid_binding", "recent binding lacks a valid logical export job")
        relative = str(binding.get("logical_manifest_relative_path") or "")
        if not relative or "\\" in relative or relative.startswith("/") or ".." in Path(relative).parts:
            raise LocatorError("invalid_binding", "recent binding logical Manifest path is invalid")
        logical_path = export_root.joinpath(*relative.split("/"))
        expected_dir = export_root / "_system" / "logical-export-jobs" / job_id
        if logical_path.parent.resolve() != expected_dir.resolve() or not re.fullmatch(r"v\d{8}\.json", logical_path.name):
            raise LocatorError("invalid_binding", "recent binding points outside the logical job directory")
        expected_sha = str(binding.get("logical_manifest_sha256") or "")
        if not logical_path.is_file() or not re.fullmatch(r"[a-f0-9]{64}", expected_sha) or hashlib.sha256(logical_path.read_bytes()).hexdigest() != expected_sha:
            raise LocatorError("invalid_binding", "recent binding logical Manifest integrity check failed")
        return {"status": "matched", "mode": "logical_export_job_id", "logical_export_job_id": job_id, "logical_manifest_path": str(logical_path), "requested_report_ids": report_ids}

    manifests = _load_all(export_root)
    shop = intent["shop_alias"]
    candidates: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    semantics = "requested_range" if mode == "date_range" else "snapshot"
    for manifest in manifests:
        if (manifest.get("shop") or {}).get("shop_alias") != shop:
            continue
        request = manifest.get("request") or {}
        if mode == "date_range" and (request.get("start_date"), request.get("end_date")) != (intent["start_date"], intent["end_date"]):
            continue
        reports = _successful_reports(manifest, report_ids, semantics)
        if reports is not None:
            candidates.append((manifest, reports))
    if not candidates:
        return {"status": "missing", "code": "exact_dataset_missing", "message": "没有找到与店铺、范围和报表完全一致的已验证导出数据。"}

    if mode == "date_range":
        advertiser_owned = _requires_advertiser(candidates)
        if advertiser_owned and ("advertiser_id" in intent or "advertiser_name" in intent):
            candidates = [(manifest, reports) for manifest, reports in candidates if _advertiser_matches(manifest, intent)]
            if not candidates:
                return {"status": "missing", "code": "exact_dataset_missing", "message": "没有找到与店铺、范围、报表和广告户完全一致的已验证导出数据。"}
        advertiser_keys = {
            ((m.get("selected_advertiser") or {}).get("advertiser_id"), (m.get("selected_advertiser") or {}).get("advertiser_name"))
            for m, _ in candidates
        }
        if advertiser_owned and len(advertiser_keys) > 1 and "advertiser_id" not in intent and "advertiser_name" not in intent:
            return {"status": "ambiguous", "code": "advertiser_required", "message": "存在多个广告户的同等匹配数据。", "choices": [_choice(m) for m, _ in candidates]}
        if len(candidates) > 1:
            selected = _stable_latest(candidates)
            return {"status": "matched", "mode": mode, "datasets": [_result_for(*selected)]}
        return {"status": "matched", "mode": mode, "datasets": [_result_for(*candidates[0])]}

    if mode == "all_snapshots":
        ordered = sorted(candidates, key=lambda pair: pair[0].get("published_at_utc") or pair[0].get("created_at") or "")
        return {"status": "matched", "mode": mode, "datasets": [_result_for(m, r) for m, r in ordered]}

    def snapshot_time(pair: tuple[dict[str, Any], list[dict[str, Any]]]) -> str:
        times = [r.get("captured_at") for r in pair[1]]
        if any(not isinstance(value, str) for value in times):
            raise LocatorError("invalid_snapshot", "snapshot report is missing captured_at")
        for value in times:
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise LocatorError("invalid_snapshot", f"invalid captured_at: {value}") from exc
        return min(times)

    ranked = [(snapshot_time(pair), pair) for pair in candidates]
    latest = max(time for time, _ in ranked)
    winners = [pair for time, pair in ranked if time == latest]
    if len(winners) != 1:
        return {"status": "ambiguous", "code": "latest_snapshot_tie", "message": "最近快照时间相同，无法唯一选择。", "choices": [_choice(m) for m, _ in winners]}
    return {"status": "matched", "mode": mode, "datasets": [_result_for(*winners[0])]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--intent-json")
    source.add_argument("--intent-file", type=Path)
    parser.add_argument("--export-root", type=Path)
    parser.add_argument("--chat-id")
    args = parser.parse_args(argv)
    try:
        raw = json.loads(args.intent_json) if args.intent_json is not None else json.loads(args.intent_file.read_text(encoding="utf-8"))
        export_root = normalize_data_root(args.export_root, "export_data_root") if args.export_root else load_pipeline_runtime_config()["export_data_root"]
        result = locate(normalize_intent(raw), export_root, args.chat_id)
        result["runtime_root_resolution"] = {"export_data_root": "explicit_cli_override" if args.export_root else "shared_runtime_config"}
    except (json.JSONDecodeError, OSError) as exc:
        result = {"status": "invalid", "code": "invalid_intent_json", "message": str(exc)}
    except LocatorError as exc:
        result = {"status": "invalid", "code": exc.code, "message": exc.message}
        if exc.details is not None:
            result["details"] = exc.details
    except CleaningError as exc:
        result = {"status": "invalid", "code": exc.code, "message": str(exc)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return {"matched": 0, "missing": 2, "ambiguous": 3}.get(result["status"], 4)


if __name__ == "__main__":
    sys.exit(main())
