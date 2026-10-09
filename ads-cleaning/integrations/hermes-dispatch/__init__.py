"""Hermes tool entry for deterministic TikTok Shop input location and cleaning."""

from __future__ import annotations

import json
import hashlib
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


TOOL_NAME = "locate_tiktok_cleaning_inputs"
TOOLSET = "tiktok_shop_data_cleaning"
_REPLIES: dict[str, str] = {}


def _report_set_path() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "hermes" / "skills" / "tiktok-shop-data-export" / "config" / "report-set.json"


def _load_report_set() -> dict[str, Any]:
    payload = json.loads(_report_set_path().read_text(encoding="utf-8"))
    if payload.get("schema_version") != "report_set_v1" or not isinstance(payload.get("categories"), dict) or not isinstance(payload.get("reports"), dict):
        raise ValueError("invalid export report registry")
    return payload


def _scope_values(report_set: dict[str, Any]) -> list[str]:
    enabled = {report_id for report_id, spec in report_set["reports"].items() if isinstance(spec, dict) and spec.get("enabled") is True}
    categories = [f"category:{name}" for name, reports in report_set["categories"].items() if any(report in enabled for report in reports)]
    return ["default", "all", *categories, *(f"report:{report_id}" for report_id in sorted(enabled))]


def _scope_help(report_set: dict[str, Any]) -> str:
    aliases = (report_set.get("message_aliases") or {}).get("categories") or {}
    parts = []
    for name in report_set["categories"]:
        labels = aliases.get(name) or []
        if labels:
            parts.append(f"{labels[0]}=category:{name}")
    return "；".join(parts)


def _tool_schema(report_set: dict[str, Any]) -> dict[str, Any]:
    return {
    "name": TOOL_NAME,
    "description": (
        "用户要求清洗、整理或处理已经导出的TikTok Shop数据时必须调用此工具，不要使用execute_code、terminal、search_files或目录遍历。"
        "此工具定位并校验已有导出，然后对当前已实现的报表生成确定性清洗结果；不会重新导出或修改原始文件。"
        "‘刚刚导出的数据’使用mode=recent_batch并令data_scopes=null，同时省略shop_alias和日期。"
        "当工具或上一步导出已提供logical_export_job_id时，必须继续传入该值，以合并整个逻辑导出任务而不是只清洗最后一个物理批次。"
        "明确日期数据使用mode=date_range，日期转成YYYY-MM-DD；请求区间必须与已有导出完全一致。"
        "data_scopes使用导出Skill的权威业务类别，不要自行填写report_id。"
        f"当前类别：{_scope_help(report_set)}。"
        "非日期数据默认mode=latest_snapshot；明确要求全部历史快照时使用all_snapshots。"
        "用户未指定广告户时省略广告户字段，不得猜测。清洗结果只保存到本机清洗目录，不向飞书上传或附加文件。"
        "工具结果返回后仅回复CLEANING_LOCATED，最终文字由插件确定性替换。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "mode": {"type": "string", "enum": ["date_range", "latest_snapshot", "all_snapshots", "recent_batch"]},
            "shop_alias": {"type": ["string", "null"], "description": "recent_batch可为null，其他模式填写用户指定店铺。"},
            "data_scopes": {"type": ["array", "null"], "items": {"type": "string", "enum": _scope_values(report_set)}, "uniqueItems": True, "description": "使用category:*；明确单表才使用report:*；recent_batch且用户未限制类型时为null。"},
            "start_date": {"type": ["string", "null"], "pattern": r"^\d{4}-\d{2}-\d{2}$"},
            "end_date": {"type": ["string", "null"], "pattern": r"^\d{4}-\d{2}-\d{2}$"},
            "advertiser_id": {"type": ["string", "null"]},
            "advertiser_name": {"type": ["string", "null"]},
            "logical_export_job_id": {"type": ["string", "null"], "pattern": r"^[0-9a-fA-F-]{36}$", "description": "仅用于recent_batch或继续清洗已知逻辑导出任务。"},
        },
        "required": ["mode", "shop_alias", "data_scopes", "start_date", "end_date", "advertiser_id", "advertiser_name", "logical_export_job_id"],
        "additionalProperties": False,
    },
    }


def _session_value(name: str) -> str:
    from gateway.session_context import get_session_env
    return str(get_session_env(name, ""))


def _locator_script() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "hermes" / "skills" / "tiktok-shop-data-cleaning" / "scripts" / "locate_exports.py"


def _cleaner_script() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "hermes" / "skills" / "tiktok-shop-data-cleaning" / "scripts" / "clean_exports.py"


def _business_view_script() -> Path:
    return _cleaning_skill_root() / "scripts" / "refresh_business_directory.py"


def _source_only_subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _model_path() -> Path:
    return _cleaning_skill_root() / "config" / "first-model-v1.json"


def _cleaning_skill_root() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "hermes" / "skills" / "tiktok-shop-data-cleaning"


def _runtime_config() -> dict[str, Any]:
    scripts = _cleaning_skill_root() / "scripts"
    module_path = scripts / "pipeline_runtime_config.py"
    if not module_path.is_file():
        raise ValueError("shared runtime config loader is not deployed")
    scripts_value = str(scripts)
    if scripts_value not in sys.path:
        sys.path.insert(0, scripts_value)
    spec = importlib.util.spec_from_file_location("tiktok_cleaning_pipeline_runtime_config", module_path)
    if spec is None or spec.loader is None:
        raise ValueError("shared runtime config loader is invalid")
    module = importlib.util.module_from_spec(spec)
    previous_dont_write_bytecode = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous_dont_write_bytecode
    try:
        return module.load_pipeline_runtime_config()
    except module.CleaningError as exc:
        raise ValueError(f"shared runtime config failed: {exc.code}") from exc


def _output_root() -> Path:
    return _runtime_config()["cleaning_data_root"]


def _export_root() -> Path:
    return _runtime_config()["export_data_root"]


def _recent_logical_job_id(chat_id: str) -> str | None:
    binding = _export_root() / "_system" / "recent-bindings" / f"{hashlib.sha256(chat_id.encode('utf-8')).hexdigest()}.json"
    if not binding.is_file():
        return None
    payload = json.loads(binding.read_text(encoding="utf-8"))
    if payload.get("schema_version") != "hermes_recent_export_v3" or payload.get("chat_id") != chat_id:
        return None
    value = payload.get("logical_export_job_id")
    return str(value) if isinstance(value, str) and value else None


def _logical_job_context(logical_export_job_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", logical_export_job_id):
        raise ValueError("invalid logical_export_job_id")
    directory = _export_root() / "_system" / "logical-export-jobs" / logical_export_job_id
    candidates = sorted(directory.glob("v????????.json"))
    if not candidates:
        raise ValueError("logical export job not found")
    payload = None
    previous_children: list[str] = []
    frozen_request = None
    frozen_compatibility = None
    for version, candidate in enumerate(candidates, start=1):
        if candidate.name != f"v{version:08d}.json":
            raise ValueError("logical export job version chain is not contiguous")
        value = json.loads(candidate.read_text(encoding="utf-8"))
        children = value.get("child_export_batch_ids") or []
        if (
            value.get("schema_version") != "logical_export_job_manifest_v1"
            or value.get("logical_export_job_id") != logical_export_job_id
            or value.get("manifest_version") != version
            or value.get("supersedes_manifest_version") != (version - 1 or None)
            or not isinstance(children, list)
            or children[:len(previous_children)] != previous_children
            or (version > 1 and value.get("normalized_request") != frozen_request)
            or (version > 1 and value.get("compatibility_identity") != frozen_compatibility)
        ):
            raise ValueError("invalid logical export job manifest")
        if version == 1:
            frozen_request = value.get("normalized_request")
            frozen_compatibility = value.get("compatibility_identity")
        previous_children = children
        payload = value
    latest = candidates[-1]
    assert payload is not None
    request = payload.get("normalized_request") or {}
    report_ids = request.get("report_ids")
    if not isinstance(report_ids, list) or not report_ids or any(not isinstance(item, str) or not item for item in report_ids):
        raise ValueError("logical export job report set is missing")
    return {
        "logical_export_job_id": logical_export_job_id,
        "report_ids": report_ids,
        "shop_id": request.get("shop_id"),
        "shop_alias": request.get("shop_alias"),
        "request": {"start_date": request.get("requested_start_date"), "end_date": request.get("requested_end_date")},
        "selected_advertiser": {"advertiser_id": request.get("advertiser_id")},
        "logical_job_status": payload.get("logical_job_status"),
    }


def _cleanable_report_ids() -> set[str]:
    model = json.loads(_model_path().read_text(encoding="utf-8"))
    return {item["report_id"] for item in model.get("datasets", []) if item.get("capability_status") == "model_ready"}


def _dataset_specs() -> dict[str, dict[str, Any]]:
    model = json.loads(_model_path().read_text(encoding="utf-8"))
    return {item["name"]: item for item in model.get("datasets", []) if isinstance(item, dict) and item.get("name")}


def _expand_scopes(scopes: list[str], report_set: dict[str, Any]) -> list[str]:
    enabled = {report_id for report_id, spec in report_set["reports"].items() if isinstance(spec, dict) and spec.get("enabled") is True}
    expanded: list[str] = []
    for scope in scopes:
        if scope == "default":
            names = report_set.get("default_categories") or []
            reports = [report for name in names for report in report_set["categories"].get(name, [])]
        elif scope == "all":
            reports = sorted(enabled)
        elif scope.startswith("category:"):
            name = scope.removeprefix("category:")
            if name not in report_set["categories"]:
                raise ValueError(f"unknown category: {name}")
            reports = report_set["categories"][name]
        elif scope.startswith("report:"):
            reports = [scope.removeprefix("report:")]
        else:
            raise ValueError(f"unknown scope: {scope}")
        for report in reports:
            if report not in enabled:
                raise ValueError(f"report is not enabled: {report}")
            if report not in expanded:
                expanded.append(report)
    return expanded


def _intent(args: dict[str, Any], report_set: dict[str, Any]) -> dict[str, Any]:
    intent = {key: value for key, value in args.items() if key not in {"data_scopes", "logical_export_job_id"} and value is not None}
    scopes = args.get("data_scopes")
    if scopes is not None:
        if not isinstance(scopes, list) or not scopes:
            raise ValueError("data_scopes must be null or a non-empty array")
        intent["report_ids"] = _expand_scopes(scopes, report_set)
    return intent


def _file_count(payload: dict[str, Any]) -> int:
    return sum(len(report.get("files") or []) for dataset in payload.get("datasets") or [] for report in dataset.get("reports") or [])


def _refresh_business_view(clean_payload: dict[str, Any]) -> dict[str, Any]:
    context = clean_payload.get("display_context") or {}
    shop_id = context.get("shop_id")
    cleaning_batch_id = clean_payload.get("cleaning_batch_id")
    if not all(isinstance(value, str) and value for value in (shop_id, cleaning_batch_id)) or not clean_payload.get("datasets"):
        return {"status": "failed", "code": "business_view_context_incomplete"}
    view_script = _business_view_script()
    if not view_script.is_file():
        return {"status": "failed", "code": "business_view_entry_not_deployed"}
    view_run = subprocess.run(
        [sys.executable, str(view_script), "--shop-id", shop_id],
        capture_output=True, timeout=300,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), env=_source_only_subprocess_env(),
    )
    view = json.loads(view_run.stdout.decode("utf-8"))
    if view.get("status") not in {"published", "reused"}:
        return {"status": "failed", "code": view.get("code") or "business_view_refresh_failed"}
    return {
        "status": view["status"],
        "cleaning_batch_id": cleaning_batch_id,
        "shop_alias": context.get("shop_alias"),
        "view_id": view.get("view_id"),
    }


def _reply(payload: dict[str, Any]) -> str:
    status = payload.get("status")
    if status == "matched":
        datasets = payload.get("datasets") or []
        reports = sum(len(dataset.get("reports") or []) for dataset in datasets)
        batches = "、".join(str(dataset.get("export_batch_id")) for dataset in datasets)
        cleaning = payload.get("cleaning_results") or []
        unsupported = payload.get("unsupported_reports") or []
        if not cleaning:
            return f"已找到并校验清洗输入\n批次：{batches}\n报表：{reports} 个\n文件：{_file_count(payload)} 个\n这些报表当前尚未实现确定性清洗：{'、'.join(unsupported) or '未识别'}。"
        specs = payload.get("dataset_specs") or {}
        lines = []
        for item in cleaning:
            context = item.get("display_context") or {}
            request = context.get("request") or {}
            start, end = request.get("start_date"), request.get("end_date")
            date_label = str(start) if start and start == end else (f"{start} 至 {end}" if start and end else "非日期数据")
            advertiser = context.get("selected_advertiser") or {}
            advertiser_label = advertiser.get("advertiser_name") or advertiser.get("advertiser_id") or "未记录"
            owners = context.get("report_owners") or {}
            for name, rows in sorted((item.get("datasets") or {}).items()):
                spec = specs.get(name) or {}
                display_name = spec.get("display_name") or name
                report_id = spec.get("report_id")
                advertiser_part = f"｜广告户：{advertiser_label}" if owners.get(report_id) == "advertiser" else ""
                lines.append(f"- {context.get('shop_alias') or '未记录店铺'}｜{date_label}{advertiser_part}｜{display_name}：{rows} 条")
        suffix = f"\n尚未实现：{'、'.join(unsupported)}" if unsupported else ""
        lines_text = "\n".join(lines)
        partial_items = [item for item in cleaning if item.get("cleaning_package_status") == "partial"]
        partial_lines = []
        for item in partial_items:
            for failure in item.get("failed_reports") or []:
                partial_lines.append(f"- 失败报表：{failure.get('report_id')}（{failure.get('code')}）")
                partial_lines.append(f"  表头指纹：{failure.get('observed_header_sha256')}")
                for difference in failure.get("differences") or []:
                    partial_lines.append(
                        f"  第{difference.get('column')}列：期望 {difference.get('expected')!r}，实际 {difference.get('actual')!r}"
                    )
            for missing in item.get("dashboard_missing_tables") or []:
                partial_lines.append(f"- 未生成看板：{missing.get('table_name')}（缺少来源）")
        partial_text = ("\n\n部分完成详情：\n" + "\n".join(partial_lines)) if partial_lines else ""
        views = [item.get("business_view") or {} for item in cleaning]
        if views and all(item.get("status") in {"published", "reused"} for item in views):
            shops = "、".join(sorted({str(item.get("shop_alias")) for item in views if item.get("shop_alias")}))
            view_line = f"\n业务展示目录：D:\\广告数据部\\{shops}（不上传飞书文件）"
        else:
            codes = "、".join(sorted({str(item.get("code") or "unknown") for item in views if item.get("status") == "failed"}))
            view_line = f"\n业务展示目录未刷新：{codes or '没有可发布的业务视图'}"
        if partial_items:
            succeeded = sum(len(item.get("successful_report_ids") or []) for item in partial_items)
            heading = f"数据清洗部分完成（成功报表：{succeeded} 张）"
        elif not views or any(item.get("status") == "failed" for item in views):
            heading = "基础清洗完成、看板发布失败"
        elif any(item.get("dashboard_status") == "partial" for item in cleaning):
            missing = sum(int(item.get("dashboard_missing") or 0) for item in cleaning)
            heading = f"基础清洗完成、看板生成不完整（缺少来源：{missing} 张）"
        else:
            heading = "数据清洗完成"
        return f"{heading}\n\n清洗结果：\n{lines_text}{suffix}{partial_text}{view_line}"
    if status == "cleaning_failed":
        code = payload.get("code")
        if code == "cleaning_runtime_version_mismatch":
            detail = "清洗模型与本机运行目录的版本未同步，请在修复版本绑定后重试。"
        else:
            detail = "清洗过程在确定性校验门禁处停止；原始导出数据未被修改。"
        return f"已找到导出数据，但清洗校验未通过。\n错误码：{code}\n{detail}"
    if status == "missing":
        return f"没有找到完全匹配的已导出数据。\n{payload.get('message', '')}\n请先导出对应店铺、完整日期范围和数据类型。"
    if status == "ambiguous":
        choices = payload.get("choices") or []
        labels = []
        for choice in choices[:6]:
            advertiser = choice.get("selected_advertiser") or {}
            labels.append(f"- 批次 {choice.get('export_batch_id')}，广告户 {advertiser.get('advertiser_name') or advertiser.get('advertiser_id') or '未记录'}")
        return "找到多个同等匹配的数据，请明确广告户或批次：\n" + "\n".join(labels)
    return f"清洗输入校验未通过：{payload.get('message') or payload.get('code') or 'unknown'}"


def _handle(args: dict[str, Any], **kwargs: Any) -> str:
    session_id = str(kwargs.get("session_id") or _session_value("HERMES_SESSION_ID"))
    chat_id = _session_value("HERMES_SESSION_CHAT_ID")
    script = _locator_script()
    if not session_id or not chat_id:
        return json.dumps({"success": False, "error": "Hermes飞书会话上下文不存在"}, ensure_ascii=False)
    cleaner = _cleaner_script()
    if not script.is_file() or not cleaner.is_file():
        return json.dumps({"success": False, "error": "清洗定位器未部署"}, ensure_ascii=False)
    try:
        report_set = _load_report_set()
        intent = _intent(args, report_set)
        logical_job_id = args.get("logical_export_job_id")
        if logical_job_id and args.get("mode") != "recent_batch":
            raise ValueError("logical_export_job_id requires recent_batch mode")
        if not logical_job_id and args.get("mode") == "recent_batch":
            logical_job_id = _recent_logical_job_id(chat_id)
        if logical_job_id:
            context = _logical_job_context(str(logical_job_id))
            requested = intent.get("report_ids") or context["report_ids"]
            if not set(requested).issubset(set(context["report_ids"])):
                raise ValueError("requested reports are outside the logical export job")
            cleanable = _cleanable_report_ids()
            selected = [report_id for report_id in requested if report_id in cleanable]
            unsupported = sorted(set(requested) - set(selected))
            specs = _dataset_specs()
            report_owners = {
                spec.get("report_id"): spec.get("owner_type")
                for spec in specs.values()
                if spec.get("report_id") in selected
            }
            payload = {"status": "matched", "mode": "logical_export_job_id", "datasets": []}
            cleaning_results = []
            if selected:
                clean_command = [sys.executable, str(cleaner), "--logical-export-job-id", str(logical_job_id)]
                for report_id in selected:
                    clean_command.extend(["--report-id", report_id])
                cleaned = subprocess.run(
                    clean_command,
                    capture_output=True,
                    timeout=300,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    env=_source_only_subprocess_env(),
                )
                clean_payload = json.loads(cleaned.stdout.decode("utf-8"))
                if clean_payload.get("status") not in {"created", "reused"}:
                    payload = {"status": "cleaning_failed", "code": clean_payload.get("code"), "message": clean_payload.get("message")}
                else:
                    clean_payload["display_context"] = {
                        "shop_id": context.get("shop_id"),
                        "shop_alias": context.get("shop_alias"),
                        "request": context.get("request") or {},
                        "selected_advertiser": context.get("selected_advertiser") or {},
                        "report_owners": report_owners,
                    }
                    clean_payload["business_view"] = _refresh_business_view(clean_payload)
                    cleaning_results.append(clean_payload)
            if payload.get("status") == "matched":
                payload["cleaning_results"] = cleaning_results
                payload["unsupported_reports"] = unsupported
                payload["dataset_specs"] = specs
                payload["logical_export_job_id"] = logical_job_id
        else:
            command = [sys.executable, str(script), "--intent-json", json.dumps(intent, ensure_ascii=False, separators=(",", ":")), "--chat-id", chat_id]
            completed = subprocess.run(
                command,
                capture_output=True,
                timeout=60,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                env=_source_only_subprocess_env(),
            )
            payload = json.loads(completed.stdout.decode("utf-8"))
        if not logical_job_id and payload.get("status") == "matched":
            cleanable = _cleanable_report_ids()
            cleaning_results = []
            unsupported = []
            for dataset in payload.get("datasets") or []:
                report_ids = [report.get("report_id") for report in dataset.get("reports") or []]
                selected = [report_id for report_id in report_ids if report_id in cleanable]
                unsupported.extend(report_id for report_id in report_ids if report_id not in cleanable)
                if not selected:
                    continue
                manifest_path = Path(dataset["manifest_path"])
                clean_command = [sys.executable, str(cleaner), "--manifest", str(manifest_path)]
                for report_id in selected:
                    clean_command.extend(["--report-id", report_id])
                cleaned = subprocess.run(
                    clean_command,
                    capture_output=True,
                    timeout=300,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    env=_source_only_subprocess_env(),
                )
                clean_payload = json.loads(cleaned.stdout.decode("utf-8"))
                if clean_payload.get("status") not in {"created", "reused"}:
                    payload = {"status": "cleaning_failed", "code": clean_payload.get("code"), "message": clean_payload.get("message")}
                    break
                clean_payload["display_context"] = {
                    "shop_id": (dataset.get("shop") or {}).get("seller_id"),
                    "shop_alias": (dataset.get("shop") or {}).get("shop_alias"),
                    "request": dataset.get("request") or {},
                    "selected_advertiser": dataset.get("selected_advertiser") or {},
                    "report_owners": {report.get("report_id"): report.get("owner_type") for report in dataset.get("reports") or []},
                }
                clean_payload["business_view"] = _refresh_business_view(clean_payload)
                cleaning_results.append(clean_payload)
            if payload.get("status") == "matched":
                payload["cleaning_results"] = cleaning_results
                payload["unsupported_reports"] = sorted(set(unsupported))
                payload["dataset_specs"] = _dataset_specs()
    except (OSError, subprocess.TimeoutExpired, UnicodeDecodeError, json.JSONDecodeError, ValueError, IndexError):
        return json.dumps({"success": False, "error": "清洗定位器执行失败"}, ensure_ascii=False)
    _REPLIES[session_id] = _reply(payload)
    return json.dumps({"success": True, "status": payload.get("status"), "reply_contract": "仅回复CLEANING_LOCATED。"}, ensure_ascii=False)


def register(ctx: Any) -> None:
    def deterministic_reply(*, response_text: str, session_id: str, platform: str, **_: Any) -> str | None:
        if platform != "feishu":
            return None
        return _REPLIES.pop(str(session_id), None)

    schema = _tool_schema(_load_report_set())
    ctx.register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=schema, handler=_handle, description=schema["description"], emoji="🧹")
    ctx.register_hook("transform_llm_output", deterministic_reply)


__all__ = ["register"]
