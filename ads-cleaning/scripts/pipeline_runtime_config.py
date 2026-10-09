"""Fail-closed loader for the shared TikTok Shop pipeline runtime roots."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping

from cleaning.errors import CleaningError

SCHEMA_VERSION = "tiktok_shop_data_pipeline_runtime_v2"
CONFIG_ENVIRONMENT_VARIABLE = "TIKTOK_SHOP_DATA_PIPELINE_CONFIG"
GLOBAL_RECORDS_DIRECTORY = "99_全局生成记录_不用看"


def default_pipeline_config_path(env: Mapping[str, str] | None = None) -> Path:
    values = os.environ if env is None else env
    explicit = str(values.get(CONFIG_ENVIRONMENT_VARIABLE) or "").strip()
    if explicit:
        return Path(explicit).resolve()
    local_app_data = str(values.get("LOCALAPPDATA") or "").strip()
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return (base / "tiktok-shop-data-pipeline" / "config.json").resolve()


def _same_or_child(path: Path, parent: Path) -> bool:
    path_key = os.path.normcase(str(path))
    parent_key = os.path.normcase(str(parent))
    try:
        return os.path.commonpath([path_key, parent_key]) == parent_key
    except ValueError:
        return False


def _inside_detectable_repository(path: Path) -> bool:
    for candidate in (path, *path.parents):
        marker = candidate / ".git"
        if marker.exists():
            return True
    return False


def normalize_data_root(value: object, field: str, env: Mapping[str, str] | None = None) -> Path:
    values = os.environ if env is None else env
    raw = str(value or "").strip()
    candidate = Path(raw)
    if not raw or not candidate.is_absolute():
        raise CleaningError("pipeline_data_root_invalid", f"{field} must be an absolute path")
    root = candidate.resolve()
    if root == Path(root.anchor):
        raise CleaningError("pipeline_data_root_invalid", f"{field} must not be a filesystem root")
    for variable in ("WINDIR", "ProgramFiles", "ProgramFiles(x86)"):
        blocked = str(values.get(variable) or "").strip()
        if blocked and _same_or_child(root, Path(blocked).resolve()):
            raise CleaningError("pipeline_data_root_forbidden", f"{field} is inside a protected system directory")
    if _inside_detectable_repository(root):
        raise CleaningError("pipeline_data_root_forbidden", f"{field} is inside a Git repository")
    return root


def load_pipeline_runtime_config(
    config_path: Path | str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, object]:
    values = os.environ if env is None else env
    path = Path(config_path).resolve() if config_path is not None else default_pipeline_config_path(values)
    if not path.is_file():
        raise CleaningError("pipeline_runtime_config_missing", f"shared runtime config is missing: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleaningError("pipeline_runtime_config_invalid", f"shared runtime config is invalid: {path}") from exc
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        raise CleaningError("pipeline_runtime_config_invalid", f"shared runtime config schema is invalid: {path}")
    if "export_data_root" in value or "cleaning_data_root" in value:
        raise CleaningError("pipeline_runtime_config_invalid", f"legacy runtime root fields are forbidden: {path}")
    department_root = normalize_data_root(value.get("data_department_root"), "data_department_root", values)
    records_root = department_root / GLOBAL_RECORDS_DIRECTORY
    return {
        "schema_version": SCHEMA_VERSION,
        "data_department_root": department_root,
        "export_data_root": records_root / "导出运行",
        "cleaning_data_root": records_root / "清洗运行",
        "business_view_root": department_root,
        "config_path": path,
    }
