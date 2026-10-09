from __future__ import annotations

import math
import os
import shutil
import tempfile
from numbers import Real
from pathlib import Path
from typing import Any

import pandas as pd

from common import (
    CleaningError,
    normalize_date,
    normalize_datetime,
    normalize_hour,
    normalize_id,
    normalize_text,
    read_xlsx_rows,
    write_formatted_xlsx,
)


def _normalize_key_value(column: str, value: Any) -> Any:
    if column.endswith("ID") or column in {"Post ID", "SKU ID", "订单ID", "售后单号", "变更ID"}:
        return normalize_id(value)
    if column in {"日期", "采集日期", "快照日期", "统计开始日期", "统计结束日期"} or column.endswith("日期"):
        normalized = normalize_date(value)
        return normalized.isoformat() if normalized is not None else None
    if column == "小时":
        return normalize_hour(value)
    return normalize_text(value)


def _key(row: dict[str, Any], columns: list[str], upsert: dict[str, Any] | None = None) -> tuple[Any, ...]:
    derived = dict((upsert or {}).get("derived_key") or {})
    values: list[Any] = []
    for column in columns:
        value = row.get(column)
        rule = derived.get(column)
        if rule == "date(采集时间)":
            captured = normalize_datetime(row.get("采集时间"))
            value = captured.date() if captured is not None else None
        values.append(_normalize_key_value(column, value))
    normalized = tuple(values)
    if any(value is None for value in normalized):
        raise CleaningError("MISSING_KEY", f"无法生成 Upsert 唯一键：{columns}")
    return normalized


_DATE_COMPARISON_COLUMNS = {"评估开始", "评估结束", "指标日期"}


def _comparison_value(column: str, value: Any) -> Any:
    if value is None:
        return None
    try:
        if bool(pd.isna(value)):
            return None
    except (TypeError, ValueError):
        pass
    if column in _DATE_COMPARISON_COLUMNS:
        normalized_date = normalize_date(value)
        return normalized_date.isoformat() if normalized_date is not None else None
    if column.endswith("时间"):
        normalized_datetime = normalize_datetime(value)
        if normalized_datetime is None:
            return None
        milliseconds = normalized_datetime.microsecond // 1000 * 1000
        return normalized_datetime.replace(microsecond=milliseconds)
    return value


def _row_equal(left: dict[str, Any], right: dict[str, Any], columns: list[str]) -> bool:
    def equal(column: str) -> bool:
        left_value = _comparison_value(column, left.get(column))
        right_value = _comparison_value(column, right.get(column))
        if (
            isinstance(left_value, Real)
            and not isinstance(left_value, bool)
            and isinstance(right_value, Real)
            and not isinstance(right_value, bool)
        ):
            return math.isclose(float(left_value), float(right_value), rel_tol=1e-15, abs_tol=1e-15)
        return left_value == right_value

    return all(equal(column) for column in columns)


def _key_spec(row: dict[str, Any], upsert: dict[str, Any]) -> tuple[str, list[str], list[str]]:
    variants = list(upsert.get("key_variants") or [])
    for index, variant in enumerate(variants):
        conditions = dict(variant.get("when") or {})
        if variant.get("default") or all(normalize_text(row.get(column)) == normalize_text(value) for column, value in conditions.items()):
            return str(index), list(variant["primary_key"]), list(variant.get("plan_name_fallback") or [])
    return "base", list(upsert.get("primary_key") or upsert.get("key")), list(upsert.get("plan_name_fallback") or [])


def _deduplicate_new(rows: list[dict[str, Any]], table_config: dict[str, Any], columns: list[str]) -> list[dict[str, Any]]:
    upsert = table_config["upsert"]
    seen: dict[tuple[str, tuple[Any, ...]], dict[str, Any]] = {}
    ordered: list[dict[str, Any]] = []
    for row in rows:
        variant, key_columns, fallback_columns = _key_spec(row, upsert)
        uses_fallback = bool(fallback_columns) and normalize_id(row.get("计划ID")) is None
        active_columns = fallback_columns if uses_fallback else key_columns
        identity = (f"{variant}:{'fallback' if uses_fallback else 'primary'}", _key(row, active_columns, upsert))
        previous = seen.get(identity)
        if previous is None:
            seen[identity] = row
            ordered.append(row)
            continue
        latest_by = upsert.get("latest_by")
        if latest_by:
            old_time = normalize_datetime(previous.get(str(latest_by)))
            new_time = normalize_datetime(row.get(str(latest_by)))
            if old_time is None or new_time is None:
                raise CleaningError("MISSING_KEY", f"时间保护字段为空：{latest_by}")
            if new_time > old_time:
                seen[identity] = row
                ordered[ordered.index(previous)] = row
            elif new_time == old_time and not _row_equal(previous, row, columns):
                raise CleaningError("DATA_CONFLICT", f"相同采集时间存在不同内容：{identity[1]}")
        elif not _row_equal(previous, row, columns):
            raise CleaningError("DUPLICATE_KEY", f"本次清洗结果存在冲突重复键：{identity[1]}")
    return ordered


def _validate_existing(rows: list[dict[str, Any]], table_config: dict[str, Any]) -> None:
    upsert = table_config["upsert"]
    seen: set[tuple[str, str, tuple[Any, ...]]] = set()
    for row in rows:
        variant, primary, fallback = _key_spec(row, upsert)
        if fallback and normalize_id(row.get("计划ID")) is None:
            value = _key(row, fallback, upsert)
            identity = (variant, "fallback", value)
            if identity in seen:
                raise CleaningError("DUPLICATE_KEY", f"现有清洗表存在重复键：{value}")
        else:
            value = _key(row, primary, upsert)
            identity = (variant, "primary", value)
            if identity in seen:
                raise CleaningError("DUPLICATE_KEY", f"现有清洗表存在重复键：{value}")
        seen.add(identity)


def _matching_indexes(existing: list[dict[str, Any]], new_row: dict[str, Any], table_config: dict[str, Any]) -> list[int]:
    upsert = table_config["upsert"]
    wanted_variant, primary, fallback = _key_spec(new_row, upsert)
    eligible = [(index, row) for index, row in enumerate(existing) if _key_spec(row, upsert)[0] == wanted_variant]
    if not fallback:
        wanted = _key(new_row, primary, upsert)
        return [index for index, row in eligible if _key(row, primary, upsert) == wanted]

    plan_id = normalize_id(new_row.get("计划ID"))
    if plan_id is not None:
        wanted = _key(new_row, primary, upsert)
        primary_matches = [
            index
            for index, row in eligible
            if normalize_id(row.get("计划ID")) is not None and _key(row, primary, upsert) == wanted
        ]
        if primary_matches:
            return primary_matches
        wanted_fallback = _key(new_row, fallback, upsert)
        return [
            index
            for index, row in eligible
            if normalize_id(row.get("计划ID")) is None and _key(row, fallback, upsert) == wanted_fallback
        ]

    wanted_fallback = _key(new_row, fallback, upsert)
    return [index for index, row in eligible if _key(row, fallback, upsert) == wanted_fallback]


def _merge_rows(existing: list[dict[str, Any]], new_rows: list[dict[str, Any]], table_config: dict[str, Any]) -> list[dict[str, Any]]:
    result = [dict(row) for row in existing]
    for new_row in new_rows:
        matches = _matching_indexes(result, new_row, table_config)
        if len(matches) > 1:
            raise CleaningError("IDENTITY_CONFLICT", "计划名称回退匹配到多行，停止写入")
        if not matches:
            result.append(dict(new_row))
            continue
        index = matches[0]
        replacement = dict(new_row)
        latest_by = table_config["upsert"].get("latest_by")
        if latest_by:
            old_time = normalize_datetime(result[index].get(str(latest_by)))
            new_time = normalize_datetime(replacement.get(str(latest_by)))
            if old_time is None or new_time is None:
                raise CleaningError("MISSING_KEY", f"时间保护字段为空：{latest_by}")
            if new_time < old_time:
                continue
            if new_time == old_time:
                if _row_equal(result[index], replacement, list(table_config["columns"])):
                    continue
                raise CleaningError("DATA_CONFLICT", "相同采集时间存在不同内容")
        if normalize_id(replacement.get("计划ID")) is None:
            old_plan_id = normalize_id(result[index].get("计划ID"))
            if old_plan_id is not None:
                replacement["计划ID"] = old_plan_id
        result[index] = replacement
    return result


def _load_existing(output_path: Path, columns: list[str], table_config: dict[str, Any]) -> list[dict[str, Any]]:
    if not output_path.exists():
        return []
    rows = read_xlsx_rows(output_path)
    if rows:
        actual_columns = list(rows[0])
    else:
        actual_columns = columns
    if actual_columns != columns:
        raise CleaningError("INVALID_OUTPUT_SCHEMA", "现有清洗表表头与冻结表头不一致")
    _validate_existing(rows, table_config)
    return rows


def _validate_written(path: Path, columns: list[str], table_config: dict[str, Any], expected_rows: int) -> None:
    rows = read_xlsx_rows(path)
    actual_columns = list(rows[0]) if rows else columns
    if actual_columns != columns:
        raise CleaningError("WRITE_VALIDATION_FAILED", "写后表头校验失败")
    if len(rows) != expected_rows:
        raise CleaningError("WRITE_VALIDATION_FAILED", "写后行数校验失败")
    _validate_existing(rows, table_config)


def upsert_and_write(new_rows: pd.DataFrame, output_path: Path, table_config: dict[str, Any]) -> dict[str, int]:
    columns = list(table_config["columns"])
    if list(new_rows.columns) != columns:
        raise CleaningError("INVALID_SCHEMA", "Builder输出表头与冻结表头不一致")
    candidate_rows = _deduplicate_new(new_rows.to_dict(orient="records"), table_config, columns)
    existing_rows = _load_existing(output_path, columns, table_config)
    final_rows = _merge_rows(existing_rows, candidate_rows, table_config)
    final_frame = pd.DataFrame(final_rows, columns=columns)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{output_path.stem}.", suffix=".tmp.xlsx", dir=output_path.parent)
    os.close(temp_fd)
    temp_path = Path(temp_name)
    backup_path: Path | None = None
    replaced = False
    had_original = output_path.exists()
    try:
        write_formatted_xlsx(final_frame, temp_path, columns)
        _validate_written(temp_path, columns, table_config, len(final_rows))
        if had_original:
            backup_fd, backup_name = tempfile.mkstemp(prefix=f".{output_path.stem}.", suffix=".backup.xlsx", dir=output_path.parent)
            os.close(backup_fd)
            backup_path = Path(backup_name)
            shutil.copy2(output_path, backup_path)
        os.replace(temp_path, output_path)
        replaced = True
        _validate_written(output_path, columns, table_config, len(final_rows))
        if backup_path is not None:
            backup_path.unlink(missing_ok=True)
        return {"rows": len(final_rows)}
    except Exception:
        if replaced:
            if backup_path is not None and backup_path.exists():
                os.replace(backup_path, output_path)
            elif not had_original:
                output_path.unlink(missing_ok=True)
        raise
    finally:
        temp_path.unlink(missing_ok=True)
        if backup_path is not None:
            backup_path.unlink(missing_ok=True)
