from __future__ import annotations

from typing import Any

import pandas as pd

from common import (
    CleaningContext,
    CleaningError,
    LocatedSources,
    normalize_date,
    normalize_id,
    normalize_text,
    parse_json_object,
    read_rows,
)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return {}


def _authorization(snapshot: dict[str, Any], advertiser_id: str) -> dict[str, Any]:
    authorization = _mapping(snapshot.get("authorization"))
    items = authorization.get("autho_info_list")
    if not isinstance(items, list):
        raise CleaningError("INVALID_JSON", "authorization.autho_info_list不是数组")
    matches = [item for item in items if isinstance(item, dict) and normalize_id(item.get("adv_id")) == advertiser_id]
    if len(matches) != 1:
        raise CleaningError("IDENTITY_CONFLICT", f"广告户{advertiser_id}无法唯一匹配授权信息")
    return matches[0]


def build(context: CleaningContext, sources: LocatedSources) -> pd.DataFrame:
    columns = [
        "采集日期",
        "店铺ID",
        "店铺名称",
        "广告户ID",
        "广告户名称",
        "广告账户状态码",
        "GMV Max授权状态码",
        "CPS授权状态码",
        "支付账户ID",
        "支付账户状态码",
        "支付方式类型",
        "账户币种",
        "账户时区",
    ]
    files = sources.files.get("advertiser_account_status", [])
    if len(files) != 1:
        raise CleaningError("MISSING_SOURCE", "广告户状态快照需要唯一的广告账户状态文件")

    output: list[dict[str, Any]] = []
    for raw in read_rows(files[0]):
        advertiser_id = normalize_id(raw.get("advertiser_id"))
        if advertiser_id is None:
            raise CleaningError("MISSING_KEY", "广告账户状态缺少advertiser_id")
        snapshot = parse_json_object(raw.get("account_snapshot_json"), "account_snapshot_json")
        authorization = _authorization(snapshot, advertiser_id)
        frozen_identity = _mapping(snapshot.get("frozen_identity"))
        payment = _mapping(snapshot.get("payment"))
        payment_account = _mapping(payment.get("pa_info"))
        payment_adv = _mapping(payment.get("adv_info_vo"))
        billing = _mapping(snapshot.get("billing_options"))
        current_billing = _first_mapping(billing.get("current_billing_option"))
        fallback_billing = _first_mapping(payment.get("billing_options"))
        auth_adv = _mapping(authorization.get("adv_info"))

        pay_account_id = normalize_id(payment_account.get("account_id")) or normalize_id(payment.get("crm_account_id"))
        pay_method = current_billing.get("pay_method_type")
        if pay_method is None:
            pay_method = fallback_billing.get("pay_method_type")
        currency = normalize_text(raw.get("currency")) or normalize_text(payment_adv.get("currency"))
        output.append(
            {
                "采集日期": normalize_date(raw.get("captured_date")),
                "店铺ID": normalize_id(frozen_identity.get("seller_id")),
                "店铺名称": context.shop_root.name,
                "广告户ID": advertiser_id,
                "广告户名称": normalize_text(raw.get("advertiser_name")),
                "广告账户状态码": auth_adv.get("status"),
                "GMV Max授权状态码": authorization.get("authorization_status"),
                "CPS授权状态码": authorization.get("cps_authorization_status"),
                "支付账户ID": pay_account_id,
                "支付账户状态码": payment_account.get("status"),
                "支付方式类型": pay_method,
                "账户币种": currency,
                "账户时区": normalize_text(payment_adv.get("timezone")),
            }
        )
    if not output:
        raise CleaningError("EMPTY_SOURCE", "广告账户状态文件没有数据行")
    return pd.DataFrame(output, columns=columns)
