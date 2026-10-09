"""Associate campaign creative facts with official video catalogs by stable IDs."""
from __future__ import annotations

import csv
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from cleaning.errors import CleaningError

OUTPUT_FIELDS = [
    "association_key", "shop_id", "advertiser_id", "campaign_id", "product_id",
    "post_id", "creative_type", "metric_date", "relation_semantics",
    "official_video_source_report_id",
    "report_campaign_universe_policy", "universe_completeness_status",
    "requested_start_date", "requested_end_date", "captured_at_utc", "source_filters",
    "universe_limitations", "checked_campaign_count", "checked_product_count",
    "link_status", "unmatched_reason", "campaign_creative_record_key",
    "official_video_record_key",
]

ALLOWED_STATUSES = {
    "linked_to_one_campaign", "linked_to_multiple_campaigns",
    "not_observed_in_selected_campaign_universe_scope",
    "non_video_creative_not_applicable", "unmatched_with_reason",
}


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _stable_key(values: list[str | None]) -> str:
    payload = ["creative-official-video-association-v2", *values]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _one(values: set[str], field: str) -> str:
    if len(values) != 1:
        raise CleaningError("association_scope_mismatch", f"{field} must have one value, got {sorted(values)!r}")
    return next(iter(values))


def _scope(rows: list[dict[str, str]], field: str) -> str:
    return _one({row.get(field, "") for row in rows}, field)


def build_associations(
    relation_csv: Path,
    official_video_csv: Path,
    scope_contract: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    relations = _read_csv(relation_csv)
    official_videos = _read_csv(official_video_csv)
    if not relations:
        raise CleaningError("association_relation_empty", "campaign creative relation source must not be empty")

    shop_id = _scope(relations, "shop_id")
    start_date = _scope(relations, "requested_start_date")
    end_date = _scope(relations, "requested_end_date")
    if official_videos:
        if _scope(official_videos, "shop_id") != shop_id:
            raise CleaningError("association_shop_mismatch", "relation and official video sources belong to different shops")
        if _scope(official_videos, "requested_start_date") != start_date or _scope(official_videos, "requested_end_date") != end_date:
            raise CleaningError("association_time_scope_mismatch", "relation and official video ranges must match exactly")

    source_report_ids = {row.get("report_id", "") for row in official_videos if row.get("report_id")}
    if len(source_report_ids) > 1:
        raise CleaningError("association_video_source_mismatch", "official video catalog must come from one report")

    required_scope = {
        "relation_semantics", "report_campaign_universe_policy", "universe_completeness_status",
        "captured_at_utc", "source_filters", "universe_limitations", "official_video_source_report_id",
    }
    missing = sorted(required_scope - set(scope_contract))
    if missing:
        raise CleaningError("association_scope_contract_missing", f"scope contract missing: {','.join(missing)}")

    official_video_source_report_id = scope_contract["official_video_source_report_id"]
    if official_video_source_report_id not in {"shop_video_performance", "shop_creative_hub_video"}:
        raise CleaningError("association_video_source_unsupported", "video catalog report is not an approved official source")
    if source_report_ids and source_report_ids != {official_video_source_report_id}:
        raise CleaningError("association_video_source_mismatch", "scope contract and official video rows name different reports")
    if official_videos and official_video_source_report_id == "shop_creative_hub_video":
        relation_advertiser_id = _scope(relations, "advertiser_id")
        if _scope(official_videos, "advertiser_id") != relation_advertiser_id:
            raise CleaningError("association_advertiser_mismatch", "campaign relations and creative catalog belong to different advertisers")
    if scope_contract["universe_completeness_status"] != "complete_within_source_contract":
        raise CleaningError("association_universe_incomplete", "negative scoped association status requires a complete frozen universe")
    if not isinstance(scope_contract["source_filters"], list) or not isinstance(scope_contract["universe_limitations"], list):
        raise CleaningError("association_scope_contract_invalid", "source filters and limitations must be arrays")

    videos_by_id: dict[str, list[dict[str, str]]] = defaultdict(list)
    for video in official_videos:
        video_id = video.get("video_id", "")
        if not video_id.isdigit():
            raise CleaningError("association_video_identity_invalid", "official video IDs must be numeric values")
        videos_by_id[video_id].append(video)

    def matching_video(relation: dict[str, str]) -> dict[str, str] | None:
        candidates = videos_by_id.get(relation.get("post_id", ""), [])
        if not candidates:
            return None
        product_matches = [row for row in candidates if row.get("product_id") == relation.get("product_id")]
        selected = product_matches or candidates
        return min(selected, key=lambda row: row["record_key"])

    campaigns_by_post: dict[str, set[str]] = defaultdict(set)
    for relation in relations:
        post_id = relation.get("post_id", "")
        if post_id:
            if not post_id.isdigit():
                raise CleaningError("association_post_identity_invalid", "creative post ID must be an official numeric value")
            campaigns_by_post[post_id].add(relation["campaign_id"])

    checked_campaign_count = len({row["campaign_id"] for row in relations})
    checked_product_count = len({row["product_id"] for row in relations})
    common = {
        "shop_id": shop_id,
        "relation_semantics": scope_contract["relation_semantics"],
        "official_video_source_report_id": official_video_source_report_id,
        "report_campaign_universe_policy": scope_contract["report_campaign_universe_policy"],
        "universe_completeness_status": scope_contract["universe_completeness_status"],
        "requested_start_date": start_date,
        "requested_end_date": end_date,
        "captured_at_utc": scope_contract["captured_at_utc"],
        "source_filters": json.dumps(scope_contract["source_filters"], ensure_ascii=False, separators=(",", ":")),
        "universe_limitations": json.dumps(scope_contract["universe_limitations"], ensure_ascii=False, separators=(",", ":")),
        "checked_campaign_count": checked_campaign_count,
        "checked_product_count": checked_product_count,
    }

    output: list[dict[str, Any]] = []
    observed_video_ids: set[str] = set()
    for relation in relations:
        post_id = relation.get("post_id", "") or None
        if post_id is None:
            status, reason, video_key = "non_video_creative_not_applicable", "creative_type_has_no_video_identity", None
        else:
            matched_video = matching_video(relation)
            if matched_video is not None:
                observed_video_ids.add(post_id)
                status = "linked_to_multiple_campaigns" if len(campaigns_by_post[post_id]) > 1 else "linked_to_one_campaign"
                reason, video_key = None, matched_video["record_key"]
            else:
                status, reason, video_key = "unmatched_with_reason", "official_video_catalog_not_returned_for_exact_requested_range", None
        row = {
            **common,
            "advertiser_id": relation.get("advertiser_id") or None,
            "campaign_id": relation.get("campaign_id") or None,
            "product_id": relation.get("product_id") or None,
            "post_id": post_id,
            "creative_type": relation.get("creative_type") or None,
            "metric_date": relation.get("metric_date") or None,
            "link_status": status,
            "unmatched_reason": reason,
            "campaign_creative_record_key": relation["record_key"],
            "official_video_record_key": video_key,
        }
        row["association_key"] = _stable_key([row.get(name) for name in ["shop_id", "advertiser_id", "campaign_id", "product_id", "post_id", "creative_type", "metric_date", "campaign_creative_record_key", "official_video_record_key"]])
        output.append(row)

    for video_id in sorted(set(videos_by_id) - observed_video_ids):
        video = min(videos_by_id[video_id], key=lambda row: row["record_key"])
        row = {
            **common, "advertiser_id": None, "campaign_id": None, "product_id": None,
            "post_id": video_id, "creative_type": "Video", "metric_date": None,
            "link_status": "not_observed_in_selected_campaign_universe_scope",
            "unmatched_reason": "not_returned_by_selected_campaign_universe_and_exact_range",
            "campaign_creative_record_key": None,
            "official_video_record_key": video["record_key"],
        }
        row["association_key"] = _stable_key([row.get(name) for name in ["shop_id", "post_id", "official_video_record_key", "requested_start_date", "requested_end_date"]])
        output.append(row)

    keys = [row["association_key"] for row in output]
    if len(keys) != len(set(keys)) or any(row["link_status"] not in ALLOWED_STATUSES for row in output):
        raise CleaningError("association_output_invalid", "association keys or statuses violate the contract")
    counts = {status: sum(row["link_status"] == status for row in output) for status in sorted(ALLOWED_STATUSES)}
    qa = {
        "status": "passed", "shop_id": shop_id, "relation_rows": len(relations),
        "official_video_rows": len(official_videos), "output_rows": len(output), "status_counts": counts,
        "official_video_source_report_id": official_video_source_report_id,
        "official_video_catalog_unique_ids": len(videos_by_id),
        "official_video_catalog_duplicate_rows": len(official_videos) - len(videos_by_id),
        "checked_campaign_count": checked_campaign_count, "checked_product_count": checked_product_count,
        "official_id_only": True, "name_or_time_fallback_used": False,
    }
    return output, qa


def write_associations(rows: list[dict[str, Any]], qa: dict[str, Any], output_dir: Path) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    table = output_dir / "campaign_creative_official_video_association.csv"
    with table.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=OUTPUT_FIELDS, extrasaction="raise")
        writer.writeheader()
        writer.writerows(rows)
    qa_file = output_dir / "campaign_creative_official_video_association.qa.json"
    qa_file.write_text(json.dumps(qa, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"table": str(table), "qa": str(qa_file)}
