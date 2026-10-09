"""Source value normalization and type conversion."""
from __future__ import annotations
import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from .errors import CleaningError


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CleaningError("required_identity_missing", f"required identity is missing: {field}")
    return unicodedata.normalize("NFC", value.strip())


def _optional_string(value: Any) -> str | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    return unicodedata.normalize("NFC", str(value).strip())


def _decimal(value: Any, field: str) -> str:
    if value is None or isinstance(value, bool):
        raise CleaningError("invalid_decimal", f"invalid decimal in {field}: {value!r}")
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError) as exc:
        raise CleaningError("invalid_decimal", f"invalid decimal in {field}: {value!r}") from exc
    if not parsed.is_finite():
        raise CleaningError("invalid_decimal", f"non-finite decimal in {field}")
    return format(parsed, "f")


def _money(value: Any, field: str) -> tuple[str, str]:
    text = _required_string(value, field).replace(",", "")
    symbols = {"₱": "PHP", "$": "USD"}
    matches = [(symbol, currency) for symbol, currency in symbols.items() if text.startswith(symbol)]
    if len(matches) != 1:
        raise CleaningError("currency_symbol_unknown", f"unknown money currency in {field}: {value!r}")
    symbol, currency = matches[0]
    return _decimal(text[len(symbol):], field), currency


def _rate(value: Any, field: str) -> str:
    text = _required_string(value, field)
    if not text.endswith("%"):
        raise CleaningError("invalid_rate", f"rate lacks percent sign in {field}: {value!r}")
    return format(Decimal(_decimal(text[:-1], field)) / Decimal("100"), "f")


def _integer(value: Any, field: str) -> str:
    raw = _decimal(value, field)
    parsed = Decimal(raw)
    if parsed != parsed.to_integral_value():
        raise CleaningError("invalid_integer", f"invalid integer in {field}: {value!r}")
    return str(int(parsed))


def _date_value(value: Any, field: str, nullable: bool = False) -> str | None:
    if nullable and (value is None or str(value).strip() in {"", "-"}):
        return None
    if isinstance(value, datetime):
        parsed = value.date()
    elif isinstance(value, date):
        parsed = value
    else:
        text = str(value).strip()
        try:
            parsed = datetime.fromisoformat(text).date()
        except ValueError as exc:
            raise CleaningError("invalid_date", f"invalid date in {field}: {value!r}") from exc
    return parsed.isoformat()


def _hour_value(value: Any, field: str) -> str:
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).strip())
        except ValueError as exc:
            raise CleaningError("invalid_datetime_hour", f"invalid hour in {field}: {value!r}") from exc
    if parsed.minute or parsed.second or parsed.microsecond:
        raise CleaningError("hour_not_aligned", f"hour is not aligned in {field}: {value!r}")
    return parsed.isoformat(timespec="seconds")


def _datetime_value(value: Any, field: str) -> str:
    text = _required_string(value, field)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CleaningError("invalid_datetime", f"invalid datetime in {field}: {value!r}") from exc
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _datetime_value_nullable(value: Any, field: str) -> str | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    return _datetime_value(value, field)


def _utc_datetime_value(value: Any, field: str) -> str:
    text = _datetime_value(value, field)
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset().total_seconds() != 0:
        raise CleaningError("invalid_utc_datetime", f"UTC datetime is required in {field}: {value!r}")
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _seller_time_context(shop: dict[str, Any]) -> dict[str, str]:
    seller_id = _required_string(shop.get("seller_id"), "shop.seller_id")
    region = _required_string(shop.get("shop_region"), "shop.shop_region").upper()
    timezone = _required_string(shop.get("business_timezone"), "shop.business_timezone")
    source = _required_string(shop.get("business_timezone_source"), "shop.business_timezone_source")
    observed_at = _utc_datetime_value(shop.get("business_timezone_observed_at"), "shop.business_timezone_observed_at")
    if not re.fullmatch(r"[A-Z]{2}", region):
        raise CleaningError("shop_region_invalid", f"shop region must be ISO alpha-2: {region!r}")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9._+-]*(?:/[A-Za-z0-9._+-]+)+", timezone):
        raise CleaningError("business_timezone_invalid", f"business timezone must be an IANA name: {timezone!r}")
    if source != "official_seller_common_get_current_seller":
        raise CleaningError("business_timezone_source_invalid", f"unsupported business timezone source: {source!r}")
    return {"seller_id": seller_id, "shop_region": region, "business_timezone": timezone, "business_timezone_source": source, "business_timezone_observed_at": observed_at}


def _order_datetime_value(value: Any, field: str, nullable: bool = False) -> str | None:
    text = "" if value is None else str(value).strip()
    if nullable and text in {"", "-"}:
        return None
    try:
        return datetime.strptime(text, "%m/%d/%Y %I:%M:%S %p").isoformat(timespec="seconds")
    except ValueError as exc:
        raise CleaningError("invalid_order_datetime", f"invalid order datetime in {field}: {value!r}") from exc


def _convert(value: Any, field: dict[str, Any]) -> str | None:
    field_type = field["type"]
    name = field["name"]
    if field_type in {"decimal", "decimal_rate"}:
        return _decimal(value, name)
    if field_type == "rate":
        return _rate(value, name)
    if field_type == "rate_nullable":
        if value is None or str(value).strip() in {"", "-"}:
            return None
        return _rate(value, name)
    if field_type == "integer":
        return _integer(value, name)
    if field_type == "integer_nullable":
        if value is None or str(value).strip() in {"", "-"}:
            return None
        return _integer(value, name)
    if field_type == "decimal_nullable":
        if value is None or str(value).strip() in {"", "-"}:
            return None
        return _decimal(value, name)
    if field_type == "date":
        return _date_value(value, name)
    if field_type == "date_nullable":
        return _date_value(value, name, nullable=True)
    if field_type == "datetime_hour":
        return _hour_value(value, name)
    if field_type == "datetime":
        return _datetime_value(value, name)
    if field_type == "datetime_nullable":
        return _datetime_value_nullable(value, name)
    if field_type == "order_datetime":
        return _order_datetime_value(value, name)
    if field_type == "order_datetime_nullable":
        return _order_datetime_value(value, name, nullable=True)
    if field_type == "id_string":
        return _required_string(str(value) if value is not None else None, name)
    if field_type == "id_string_nullable":
        return _optional_string(str(value) if value is not None else None)
    if field_type == "string_nullable":
        return _optional_string(value)
    if field_type == "string":
        return _required_string(str(value) if value is not None else None, name)
    raise CleaningError("unsupported_field_type", f"unsupported field type: {field_type}")
