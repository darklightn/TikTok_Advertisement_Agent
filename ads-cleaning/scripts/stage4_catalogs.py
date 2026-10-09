"""Deterministic Stage 4 Dataset Catalog and capability-ledger snapshots."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from pipeline_runtime_config import load_pipeline_runtime_config, normalize_data_root


MODEL_SCHEMA = "tiktok_cleaning_model_v1"
CATALOG_SCHEMA = "dataset_catalog_v1"
LEDGER_SOURCE_SCHEMA = "stage6_6_capability_ledger_v2"
LEDGER_SCHEMA = "capability_ledger_snapshot_v1"
POINTER_SCHEMA = "versioned_runtime_pointer_v1"
VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]*$")
ALLOWED_TIME_SEMANTICS = {"metric_date", "metric_hour", "requested_interval", "snapshot", "event", "operational_record"}
ALLOWED_CAPABILITY_STATUSES = {"supported", "verified_unavailable", "blocked", "deferred"}


class Stage4ContractError(ValueError):
    pass


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _hash_without(value: dict[str, Any], field: str) -> str:
    payload = dict(value)
    payload.pop(field, None)
    return hashlib.sha256(_canonical(payload)).hexdigest()


def _strings(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item for item in value) or len(value) != len(set(value)):
        raise Stage4ContractError(f"{field}_invalid")
    return value


def _field_aggregation(dataset: dict[str, Any]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for field in dataset.get("fields") or []:
        name = field.get("name")
        if not isinstance(name, str) or not name:
            raise Stage4ContractError("dataset_field_invalid")
        semantic = field.get("aggregation")
        if semantic is None:
            semantic = "derived" if str(field.get("source") or "").startswith("derived:") else "not_declared"
        if not isinstance(semantic, str) or not semantic:
            raise Stage4ContractError("field_aggregation_invalid")
        groups.setdefault(semantic, []).append(name)
    return {key: sorted(value) for key, value in sorted(groups.items())}


def model_identity_projection(model: dict[str, Any]) -> dict[str, Any]:
    protected_keys = ("name", "display_name", "report_id", "grain", "record_key_components", "content_fields", "fields", "owner_type", "currency_applicability", "common_field_policy")
    value: dict[str, Any] = {
        "schema_version": "stage4_model_identity_baseline_v1",
        "common_fields_sha256": hashlib.sha256(_canonical(model.get("common_fields"))).hexdigest(),
        "derived_metric_fields_sha256": hashlib.sha256(_canonical(model.get("derived_metric_fields"))).hexdigest(),
        "datasets": [
            {
                "dataset_name": dataset.get("name"),
                "protected_identity_sha256": hashlib.sha256(_canonical({key: dataset.get(key) for key in protected_keys})).hexdigest(),
                "explicit_contract_version": dataset.get("contract_version"),
            }
            for dataset in model.get("datasets") or []
        ],
    }
    value["identity_sha256"] = _hash_without(value, "identity_sha256")
    return value


def validate_model_identity_baseline(model: dict[str, Any], baseline: dict[str, Any]) -> dict[str, Any]:
    current = model_identity_projection(model)
    if len(current.get("datasets") or []) == len(baseline.get("datasets") or []):
        for current_dataset, baseline_dataset in zip(current["datasets"], baseline["datasets"]):
            if baseline_dataset.get("explicit_contract_version") is None and isinstance(current_dataset.get("explicit_contract_version"), str) and current_dataset["explicit_contract_version"]:
                current_dataset["explicit_contract_version"] = None
        current["identity_sha256"] = _hash_without(current, "identity_sha256")
    if _canonical(current) != _canonical(baseline):
        raise Stage4ContractError("stage4_model_identity_drift")
    return model


def build_dataset_catalog(model: dict[str, Any]) -> dict[str, Any]:
    if model.get("schema_version") != MODEL_SCHEMA or not VERSION.fullmatch(str(model.get("model_version") or "")):
        raise Stage4ContractError("model_identity_invalid")
    taxonomy = model.get("diagnostic_domain_taxonomy")
    if not isinstance(taxonomy, list) or not taxonomy:
        raise Stage4ContractError("diagnostic_domain_taxonomy_missing")
    domain_ids = []
    for item in taxonomy:
        if not isinstance(item, dict) or not isinstance(item.get("domain_id"), str) or not item["domain_id"] or not isinstance(item.get("display_name"), str) or not item["display_name"]:
            raise Stage4ContractError("diagnostic_domain_taxonomy_invalid")
        domain_ids.append(item["domain_id"])
    if len(domain_ids) != len(set(domain_ids)):
        raise Stage4ContractError("diagnostic_domain_taxonomy_duplicate")

    entries = []
    names = []
    for dataset in model.get("datasets") or []:
        name = dataset.get("name")
        if not isinstance(name, str) or not name:
            raise Stage4ContractError("dataset_name_invalid")
        names.append(name)
        domains = _strings(dataset.get("diagnostic_domains"), f"{name}.diagnostic_domains")
        if any(domain not in domain_ids for domain in domains):
            raise Stage4ContractError(f"{name}.diagnostic_domain_unknown")
        time_semantics = dataset.get("time_semantics")
        if time_semantics not in ALLOWED_TIME_SEMANTICS:
            raise Stage4ContractError(f"{name}.time_semantics_invalid")
        record_keys = _strings(dataset.get("record_key_components"), f"{name}.record_key_components")
        partition_keys = _strings(dataset.get("partition_keys"), f"{name}.partition_keys")
        available_fields = {field.get("name") for field in dataset.get("fields") or [] if isinstance(field, dict)} | set((dataset.get("common_field_policy") or {}).get("include") or [])
        if any(key not in available_fields for key in record_keys):
            raise Stage4ContractError(f"{name}.record_key_field_unavailable")
        if any(key not in available_fields for key in partition_keys):
            raise Stage4ContractError(f"{name}.partition_key_unavailable")
        if not isinstance(dataset.get("owner_type"), str) or dataset["owner_type"] not in {"shop", "advertiser"}:
            raise Stage4ContractError(f"{name}.owner_type_invalid")
        if not isinstance(dataset.get("grain"), str) or not dataset["grain"]:
            raise Stage4ContractError(f"{name}.grain_invalid")
        if not isinstance(dataset.get("contract_version"), str) or not dataset["contract_version"]:
            raise Stage4ContractError(f"{name}.contract_version_invalid")
        currency = dataset.get("currency_applicability")
        if currency not in {"required", "optional", "omit"}:
            raise Stage4ContractError(f"{name}.currency_applicability_invalid")
        if dataset.get("aggregation_semantics") != "field_level_from_dataset_fields":
            raise Stage4ContractError(f"{name}.aggregation_semantics_invalid")
        entries.append({
            "dataset_name": name,
            "report_id": dataset.get("report_id"),
            "contract_version": dataset["contract_version"],
            "diagnostic_domains": domains,
            "owner_type": dataset["owner_type"],
            "time_semantics": time_semantics,
            "grain": dataset["grain"],
            "record_key_fields": record_keys,
            "partition_keys": partition_keys,
            "currency_applicability": currency,
            "aggregation_semantics": _field_aggregation(dataset),
        })
    if not entries or len(names) != len(set(names)):
        raise Stage4ContractError("dataset_names_invalid")
    catalog: dict[str, Any] = {
        "schema_version": CATALOG_SCHEMA,
        "catalog_version": model["model_version"],
        "source_model": {"schema_version": MODEL_SCHEMA, "model_version": model["model_version"], "sha256": hashlib.sha256(_canonical(model)).hexdigest(), "sha256_scope": "UTF8_JSON_sorted_keys_compact"},
        "safe_aggregation_policy": {"explicit_field_semantics_only": True, "not_declared_behavior": "not_aggregatable", "derived_metric_behavior": "recompute_from_declared_inputs"},
        "diagnostic_domain_taxonomy": taxonomy,
        "datasets": entries,
    }
    catalog["catalog_sha256"] = _hash_without(catalog, "catalog_sha256")
    return catalog


def validate_dataset_catalog(catalog: dict[str, Any], model: dict[str, Any]) -> dict[str, Any]:
    expected = build_dataset_catalog(model)
    if _canonical(catalog) != _canonical(expected):
        raise Stage4ContractError("dataset_catalog_model_drift")
    return catalog


def build_capability_ledger_snapshot(source: dict[str, Any]) -> dict[str, Any]:
    if source.get("schema_version") != LEDGER_SOURCE_SCHEMA or not VERSION.fullmatch(str(source.get("ledger_version") or "")):
        raise Stage4ContractError("capability_ledger_source_invalid")
    allowed = _strings(source.get("allowed_statuses"), "allowed_statuses")
    if set(allowed) != ALLOWED_CAPABILITY_STATUSES:
        raise Stage4ContractError("capability_status_contract_drift")
    capabilities = source.get("capabilities")
    if not isinstance(capabilities, list) or not capabilities:
        raise Stage4ContractError("capabilities_invalid")
    ids = []
    for capability in capabilities:
        if not isinstance(capability, dict) or not isinstance(capability.get("capability_id"), str) or not capability["capability_id"]:
            raise Stage4ContractError("capability_invalid")
        if capability.get("status") not in ALLOWED_CAPABILITY_STATUSES:
            raise Stage4ContractError("capability_status_invalid")
        ids.append(capability["capability_id"])
    if len(ids) != len(set(ids)):
        raise Stage4ContractError("capability_id_duplicate")
    snapshot: dict[str, Any] = {
        "schema_version": LEDGER_SCHEMA,
        "ledger_version": source["ledger_version"],
        "source_contract": {"schema_version": LEDGER_SOURCE_SCHEMA, "sha256": hashlib.sha256(_canonical(source)).hexdigest(), "sha256_scope": "UTF8_JSON_sorted_keys_compact"},
        "allowed_statuses": allowed,
        "capabilities": capabilities,
    }
    snapshot["ledger_sha256"] = _hash_without(snapshot, "ledger_sha256")
    return snapshot


def validate_capability_ledger_snapshot(snapshot: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    expected = build_capability_ledger_snapshot(source)
    if _canonical(snapshot) != _canonical(expected):
        raise Stage4ContractError("capability_ledger_snapshot_drift")
    return snapshot


def _publish(root: Path, directory_name: str, version: str, value: dict[str, Any], hash_field: str) -> dict[str, Any]:
    if not VERSION.fullmatch(version):
        raise Stage4ContractError("runtime_snapshot_version_invalid")
    directory = root / "_system" / directory_name
    directory.mkdir(parents=True, exist_ok=True)
    version_file = directory / f"{version}.json"
    body = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if version_file.exists():
        if version_file.read_text(encoding="utf-8") != body:
            raise Stage4ContractError("immutable_runtime_snapshot_conflict")
        publication_status = "reused"
    else:
        temporary_version = directory / f".{version}.json.tmp-{os.getpid()}"
        temporary_version.write_text(body, encoding="utf-8", newline="\n")
        try:
            os.link(temporary_version, version_file)
            publication_status = "created"
        except FileExistsError:
            if version_file.read_text(encoding="utf-8") != body:
                raise Stage4ContractError("immutable_runtime_snapshot_conflict")
            publication_status = "reused"
        finally:
            temporary_version.unlink(missing_ok=True)
    pointer = {
        "schema_version": POINTER_SCHEMA,
        "version": version,
        "relative_path": version_file.relative_to(root).as_posix(),
        "content_sha256": value[hash_field],
        "file_sha256": hashlib.sha256(version_file.read_bytes()).hexdigest(),
    }
    pointer_file = directory / "current.json"
    temporary = pointer_file.with_name(f"current.json.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(pointer, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    os.replace(temporary, pointer_file)
    return {"status": publication_status, "version_path": str(version_file), "current_path": str(pointer_file), "version": version, "sha256": value[hash_field]}


def publish_stage4_snapshots(cleaning_root: Path, model: dict[str, Any], capability_source: dict[str, Any]) -> dict[str, Any]:
    catalog = build_dataset_catalog(model)
    ledger = build_capability_ledger_snapshot(capability_source)
    return {
        "schema_version": "stage4_runtime_snapshot_publication_v1",
        "dataset_catalog": _publish(cleaning_root, "dataset-catalogs", catalog["catalog_version"], catalog, "catalog_sha256"),
        "capability_ledger": _publish(cleaning_root, "capability-ledgers", ledger["ledger_version"], ledger, "ledger_sha256"),
    }


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument("--cleaning-root", type=Path)
    parser.add_argument("--model", type=Path, default=repo / "config" / "first-model-v1.json")
    parser.add_argument("--capability-ledger", type=Path, default=repo / "config" / "stage6-6-capability-ledger-v2.json")
    args = parser.parse_args(argv)
    cleaning_root = normalize_data_root(args.cleaning_root, "cleaning_data_root") if args.cleaning_root else load_pipeline_runtime_config()["cleaning_data_root"]
    result = publish_stage4_snapshots(cleaning_root, json.loads(args.model.read_text(encoding="utf-8")), json.loads(args.capability_ledger.read_text(encoding="utf-8")))
    result["runtime_root_resolution"] = {"cleaning_data_root": "explicit_cli_override" if args.cleaning_root else "shared_runtime_config"}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
