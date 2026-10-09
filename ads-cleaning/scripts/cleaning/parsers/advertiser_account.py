"""Deterministic advertiser-account status snapshot parser."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from record_key import record_key

from ..conversion import _integer, _optional_string, _required_string, _utc_datetime_value
from ..errors import CleaningError
from ..records import _base_row, _content_hash, _source_row_key

REPORT_ID = "advertiser_account_status_snapshot"
SOURCE_ID = "seller_advertiser_account_status_snapshot_v1"


def _raw(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    return _optional_string(value)


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _dataset(model: dict[str, Any]) -> dict[str, Any]:
    for item in model.get("datasets", []):
        if item.get("name") == REPORT_ID:
            return item
    raise CleaningError("unknown_dataset", f"unknown account snapshot dataset: {REPORT_ID}")


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleaningError("snapshot_unreadable", f"cannot read advertiser account snapshot: {path}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != "seller_api_snapshot_v2":
        raise CleaningError("snapshot_schema_mismatch", f"unexpected advertiser account snapshot schema: {path}")
    if value.get("source_id") != SOURCE_ID or value.get("source_contract_version") != SOURCE_ID:
        raise CleaningError("snapshot_source_mismatch", f"advertiser account source does not match contract: {path}")
    if value.get("source_object_scope") != "advertiser_account":
        raise CleaningError("snapshot_scope_mismatch", f"advertiser account source scope differs: {path}")
    collection = value.get("collection")
    valid_collections = (
        {"selected_primary_account_only": True, "endpoint_count": 6, "complete": True},
        {"selected_linked_account_only": True, "endpoint_count": 6, "complete": True},
    )
    if collection not in valid_collections:
        raise CleaningError("account_snapshot_collection_incomplete", "account snapshot completeness proof differs from contract")
    return value


def _capability(response: dict[str, Any], name: str) -> str:
    item = (response.get("capabilities") or {}).get(name)
    status = _required_string(item.get("status") if isinstance(item, dict) else None, f"capabilities.{name}.status")
    allowed = {
        "available", "not_available_current_seller_binding", "not_available_current_primary_binding",
        "not_collected_contract_not_frozen", "not_observed_in_frozen_sources",
    }
    if status not in allowed:
        raise CleaningError("account_capability_status_invalid", f"unsupported capability status for {name}: {status}")
    return status


def parse_advertiser_account(
    manifest: dict[str, Any], report_id: str, report: dict[str, Any], file_meta: dict[str, Any],
    model: dict[str, Any], batch_id: str,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    if report_id != REPORT_ID:
        raise CleaningError("unsupported_report", f"unsupported advertiser account report: {report_id}")
    snapshot = _read(Path(file_meta["path"]))
    identity = snapshot.get("identity") or {}
    selected = manifest.get("selected_advertiser") or {}
    advertiser_id = _required_string(identity.get("advertiser_id"), "snapshot.identity.advertiser_id")
    if advertiser_id != _required_string(selected.get("advertiser_id"), "selected_advertiser.advertiser_id"):
        raise CleaningError("advertiser_identity_mismatch", "snapshot advertiser differs from Manifest selection")
    if advertiser_id != str(report.get("owner_id") or ""):
        raise CleaningError("report_owner_mismatch", "snapshot advertiser differs from report owner")
    captured = _utc_datetime_value(snapshot.get("captured_at_utc"), "snapshot.captured_at_utc")
    if captured != _utc_datetime_value(file_meta.get("captured_at_utc"), "file.captured_at_utc"):
        raise CleaningError("captured_at_mismatch", "account snapshot and Manifest capture times differ")
    response = snapshot.get("response")
    if not isinstance(response, dict):
        raise CleaningError("account_snapshot_shape_mismatch", "account snapshot response must be an object")
    account = response.get("account")
    payment = response.get("payment")
    ownership = response.get("ownership")
    authorization = response.get("authorization")
    if not all(isinstance(item, dict) for item in (account, payment, ownership, authorization)):
        raise CleaningError("account_snapshot_shape_mismatch", "account snapshot sections are incomplete")
    if _required_string(account.get("advertiser_id"), "response.account.advertiser_id") != advertiser_id:
        raise CleaningError("advertiser_identity_mismatch", "response account differs from snapshot identity")
    is_primary_advertiser = account.get("is_primary_advertiser")
    if not isinstance(is_primary_advertiser, bool):
        raise CleaningError("account_primary_binding_invalid", "account primary binding must be a boolean")
    if (snapshot.get("collection") or {}).get("selected_primary_account_only") is True and not is_primary_advertiser:
        raise CleaningError("account_primary_binding_missing", "primary-account snapshot does not bind the selected primary advertiser")
    currency = _required_string(account.get("currency"), "response.account.currency")
    if currency != _required_string(file_meta.get("currency"), "file.currency"):
        raise CleaningError("currency_mismatch", "account currency differs from Manifest currency evidence")
    portfolio = payment.get("payment_portfolio")
    if portfolio is not None and not isinstance(portfolio, dict):
        raise CleaningError("account_snapshot_shape_mismatch", "payment portfolio must be an object or null")
    billing_options = payment.get("current_billing_options")
    if not isinstance(billing_options, list):
        raise CleaningError("account_snapshot_shape_mismatch", "current billing options must be a list")

    dataset = _dataset(model)
    row = _base_row(manifest, report_id, file_meta, "api_response", 1, batch_id)
    row.update({
        "advertiser_name": _optional_string(account.get("advertiser_name")),
        "captured_at_utc": captured,
        "role_raw": _raw(account.get("role_raw")),
        "account_status_raw": _raw(account.get("account_status_raw")),
        "relation_status_raw": _raw(account.get("relation_status_raw")),
        "country": _optional_string(account.get("country")),
        "timezone": _optional_string(account.get("timezone")),
        "currency": currency,
        "currency_precision": _integer(account.get("currency_precision"), "currency_precision"),
        "primary_managed_raw": _raw(account.get("primary_managed_raw")),
        "is_primary_advertiser_raw": _required_string(_raw(is_primary_advertiser), "is_primary_advertiser_raw"),
        "is_owned_by_user_raw": _raw(ownership.get("is_owned_by_user_raw")),
        "is_owned_by_business_center_raw": _raw(ownership.get("is_owned_by_business_center_raw")),
        "payment_permission_code_raw": _raw(payment.get("permission_code_raw")),
        "payment_advertiser_role_raw": _raw(payment.get("advertiser_role_raw")),
        "payment_organization_user_role_raw": _raw(payment.get("organization_user_role_raw")),
        "payment_sdk_active_raw": _raw(payment.get("payment_sdk_active_raw")),
        "payment_portfolio_version_raw": _raw(payment.get("payment_portfolio_version_raw")),
        "payment_portfolio_id": _optional_string((portfolio or {}).get("payment_portfolio_id")),
        "payment_portfolio_name": _optional_string((portfolio or {}).get("payment_portfolio_name")),
        "payment_portfolio_type_raw": _raw((portfolio or {}).get("payment_portfolio_type_raw")),
        "payment_portfolio_status_raw": _raw((portfolio or {}).get("payment_portfolio_status_raw")),
        "payment_portfolio_currency_list_json": _json_text((portfolio or {}).get("payment_portfolio_currency_list") or []),
        "payment_portfolio_status_banner_raw": _optional_string((portfolio or {}).get("payment_portfolio_status_banner_raw")),
        "payment_portfolio_is_cash_collecting_raw": _raw((portfolio or {}).get("is_cash_collecting_raw")),
        "current_billing_options_json": _json_text(billing_options),
        "billing_currency": _required_string(payment.get("billing_currency"), "billing_currency"),
        "billing_currency_precision": _integer(payment.get("billing_currency_precision"), "billing_currency_precision"),
        "billing_business_center_id": _required_string(payment.get("billing_business_center_id"), "billing_business_center_id"),
        "billing_business_center_name": _optional_string(payment.get("billing_business_center_name")),
        "owner_business_center_id": _required_string(payment.get("owner_business_center_id"), "owner_business_center_id"),
        "billing_business_center_pay_method_raw": _raw(payment.get("billing_business_center_pay_method_raw")),
        "selected_business_center_is_billing_business_center_raw": _required_string(_raw(payment.get("selected_business_center_is_billing_business_center")), "selected_business_center_is_billing_business_center_raw"),
        "authorization_status_raw": _raw(authorization.get("authorization_status_raw")),
        "cps_authorization_status_raw": _raw(authorization.get("cps_authorization_status_raw")),
        "authorization_operation_source_raw": _raw(authorization.get("operation_source_raw")),
        "authorization_binding_status": _required_string(authorization.get("binding_status"), "authorization.binding_status"),
        "authorization_observed_advertiser_id": _optional_string(authorization.get("observed_advertiser_id")),
        "authorization_capability_status": _capability(response, "authorization_status"),
        "available_balance_capability_status": _capability(response, "available_balance"),
        "spend_limit_capability_status": _capability(response, "spend_limit"),
        "account_delivery_status_capability_status": _capability(response, "account_delivery_status"),
        "account_restriction_reason_capability_status": _capability(response, "account_restriction_reason"),
    })
    row["record_key"] = record_key(dataset["name"], [row.get(name) for name in dataset["record_key_components"]])
    row["source_row_key"] = _source_row_key(file_meta["sha256"], "api_response", 1)
    row["record_content_hash"] = _content_hash(dataset["name"], row, dataset["content_fields"])
    qa = {
        "source_file": file_meta["path"], "source_rows_excluding_header": 1,
        "detail_rows": 1, "summary_rows": 0, "blank_rows": 0, "rejected_rows": 0,
        "row_conservation": True,
        "summary_reconciliation": {"status": "not_applicable", "selected_primary_account_only": True},
    }
    return dataset["name"], [row], qa
