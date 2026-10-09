"""根据内存中的扫描事实、历史映射和完整远程观测生成同步计划。"""

from copy import deepcopy
import hashlib
import re


def build_target_table_name(relative_path):
    """Apply the fixed directory suffix and character-based long-name rule."""
    parts = relative_path.split('/')
    raw = parts[-1].rsplit('.', 1)[0]
    if len(parts) == 3:
        raw += '_' + parts[-2]
    if len(raw) <= 100:
        return raw
    ranges = list(re.finditer(r'(?<!\d)\d{4}-\d{2}-\d{2}_至_\d{4}-\d{2}-\d{2}(?!\d)', raw))
    dates = list(re.finditer(r'(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)', raw))
    selected = (ranges or dates)[-1] if ranges or dates else None
    date = selected.group() if selected else ''
    body = (raw[:selected.start()] + raw[selected.end():]).strip('_') if selected else raw
    budget = 100 - len(date) - 8 - (3 if date else 2)
    head, tail = body[:(budget + 1) // 2], body[-(budget // 2):]
    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:8]
    return '_'.join([head, date, tail, digest] if date else [head, tail, digest])


def _assignments(scan_result, snapshot, capacity):
    if type(capacity) is not int or not 1 <= capacity <= 290:
        raise ValueError('Capacity must be an integer in 1..290')
    if _state_errors(snapshot, capacity):
        return {}, {}
    failed = {e.get('relative_path') for e in scan_result['errors']}
    files = {f['relative_path']: f for f in scan_result['files'] if f['relative_path'] not in failed}
    volumes, mappings = snapshot['volumes'], snapshot['by_local_path']
    number = max((_volume_number(v) for v in volumes), default=1)
    volume = f'V{number:03d}'
    count = len(volumes.get(volume, {}).get('tables', []))
    assigned = {}
    for path in sorted(files):
        if path in mappings:
            assigned[path] = mappings[path]['volume']
        else:
            if count >= capacity:
                number += 1
                volume, count = f'V{number:03d}', 0
            assigned[path] = volume
            count += 1
    absent = {p: m for p, m in mappings.items() if p not in files and p not in failed
              and scan_result.get('path_presence', {}).get(p) == 'ABSENT'}
    return assigned, absent


def _scope_scan(scan_result, selected_paths):
    if selected_paths is None:
        return scan_result
    selected = set(selected_paths)
    return dict(scan_result,
                files=[f for f in scan_result['files'] if f['relative_path'] in selected],
                errors=[e for e in scan_result['errors'] if e.get('relative_path') in selected
                        or not e.get('relative_path')],
                path_presence={})


def required_volumes(scan_result, state_snapshot, max_formal_tables_per_base=290, *, selected_paths=None):
    """Return only volumes required by scanned files or confirmed local absences."""
    scan_result = _scope_scan(scan_result, selected_paths)
    assigned, absent = _assignments(scan_result, state_snapshot, max_formal_tables_per_base)
    return sorted(set(assigned.values()) | {m['volume'] for m in absent.values()}, key=_volume_number)


def _volume_number(volume):
    if not isinstance(volume, str) or not volume.startswith("V"):
        return None
    digits = volume[1:]
    if not digits or any(c not in "0123456789" for c in digits):
        return None
    number = int(digits)
    return number if number > 0 and volume == f"V{number:03d}" else None


def _state_errors(snapshot, capacity):
    problems = {}
    paths, ids = {}, {}
    for volume, state in snapshot["volumes"].items():
        if _volume_number(volume) is None:
            problems.setdefault("INVALID_VOLUME_STATE", f"Invalid volume: {volume}")
        for item in state["tables"]:
            path, table_id = item["local_path"], item["table_id"]
            if path in paths:
                problems.setdefault("DUPLICATE_LOCAL_PATH_MAPPING", f"Duplicate path: {path}")
            if table_id in ids:
                problems.setdefault("DUPLICATE_TABLE_ID_MAPPING", f"Duplicate table ID: {table_id}")
            paths[path] = {"volume": volume, "table_id": table_id,
                           "file_hash": item["file_hash"]}
            ids[table_id] = {"volume": volume, "local_path": path}
        if len(state["tables"]) > capacity:
            problems.setdefault("STATE_VOLUME_OVER_CAPACITY", f"Over capacity: {volume}")
    # 先报告原始条目的首要问题；重复路径可能同时造成重复 ID。
    for code in ("INVALID_VOLUME_STATE", "DUPLICATE_LOCAL_PATH_MAPPING",
                 "DUPLICATE_TABLE_ID_MAPPING", "STATE_VOLUME_OVER_CAPACITY"):
        if code in problems:
            return [{"error": code, "scope": "task", "detail": problems[code]}]
    if paths != snapshot["by_local_path"] or ids != snapshot["by_table_id"]:
        return [{"error": "INVALID_VOLUME_STATE", "scope": "task"}]
    return []


def _remote_tables(observation, historical):
    """返回可靠清单；None 表示缺失或不完整的观测。"""
    if not isinstance(observation, dict):
        return None
    if observation.get("status") == "NOT_FOUND":
        return [] if not historical and observation.get("complete") is True else None
    if observation.get("status") != "READY":
        return None
    tables = observation.get("tables")
    if (not isinstance(observation.get("base_token"), str) or
            not observation["base_token"] or observation.get("complete") is not True or
            not isinstance(tables, list) or
            type(observation.get("table_count")) is not int or
            observation["table_count"] != len(tables)):
        return None
    ids = set()
    for table in tables:
        if not isinstance(table, dict) or any(
                not isinstance(table.get(key), str) or not table[key]
                for key in ("table_id", "table_name")):
            return None
        if table["table_id"] in ids:
            return None
        ids.add(table["table_id"])
    return tables


def _finish(result):
    result["errors"].sort(key=lambda e: (
        e.get("volume") or "", e.get("relative_path") or "", e["error"]))
    for key in ("unchanged", "remote_orphans"):
        result[key].sort(key=lambda item: item["relative_path"])
    # 连同透传错误中的嵌套定位信息一起隔离，避免输出反向污染输入。
    return deepcopy(result)


def plan_sync(shop_name, scan_result, state_snapshot, remote_inventory,
              base_name_template="广告数据部_{shop_name}_V{volume:03d}",
              max_formal_tables_per_base=290, *, selected_paths=None):
    """规划 CREATE / REPLACE；保留 unchanged、远程孤儿和明确错误。"""
    capacity = max_formal_tables_per_base
    if type(capacity) is not int or not 1 <= capacity <= 290:
        raise ValueError("max_formal_tables_per_base must be an integer in 1..290")
    if (not isinstance(scan_result, dict) or
            any(key not in scan_result for key in ("files", "errors", "directories", "shop")) or
            not isinstance(state_snapshot, dict) or
            any(not isinstance(state_snapshot.get(key), dict)
                for key in ("volumes", "by_local_path", "by_table_id")) or
            not isinstance(remote_inventory, dict)):
        raise ValueError("missing input containers")
    scan_result = _scope_scan(scan_result, selected_paths)
    result = {"base_queues": [], "unchanged": [], "remote_orphans": [], "errors": [], "file_volumes": {}}
    errors = result["errors"]
    errors.extend(_state_errors(state_snapshot, capacity))
    if errors:
        return _finish(result)

    failed_paths = set()
    for original in scan_result["errors"]:
        error = dict(original)
        error["scope"] = "task" if error["error"] == "SOURCE_ROOT_UNAVAILABLE" else "file"
        errors.append(error)
        failed_paths.add(error.get("relative_path"))
    for volume, observation in remote_inventory.items():
        if (isinstance(observation, dict) and observation.get("status") == "ERROR" and
                isinstance(observation.get("error"), dict) and
                observation["error"].get("scope") == "task"):
            errors.append(dict(observation["error"], volume=volume))
    if any(e["scope"] == "task" for e in errors):
        return _finish(result)

    volumes = state_snapshot["volumes"]
    mappings = state_snapshot["by_local_path"]
    files = {item["relative_path"]: item for item in scan_result["files"]
             if item["relative_path"] not in failed_paths}
    assignments, absent = _assignments(scan_result, state_snapshot, capacity)
    result['file_volumes'] = assignments
    for path, mapping in mappings.items():
        if selected_paths is not None and path not in selected_paths:
            continue
        if path in files or path in failed_paths:
            continue
        if path not in absent:
            errors.append({"error": "FILE_ACCESS_FAILED", "scope": "file",
                           "relative_path": path})

    used = set(assignments.values()) | {m["volume"] for m in absent.values()}
    inventories = {}
    for volume in sorted(used, key=_volume_number):
        observation = remote_inventory.get(volume)
        tables = _remote_tables(observation, volume in volumes)
        if tables is None:
            error = {"error": "BASE_RESOLVE_FAILED", "scope": "base"}
            if isinstance(observation, dict) and observation.get("status") == "ERROR":
                reason = observation.get("error")
                if isinstance(reason, dict):
                    error.update(reason)
                elif reason is not None:
                    error["detail"] = reason
            error["scope"], error["volume"] = "base", volume
            errors.append(error)
        else:
            inventories[volume] = tables

    for path, mapping in absent.items():
        tables = inventories.get(mapping["volume"])
        if tables is not None and any(t["table_id"] == mapping["table_id"] for t in tables):
            result["remote_orphans"].append(dict(mapping, relative_path=path))

    candidates = {}
    for path in sorted(files):
        volume = assignments[path]
        if volume not in inventories:
            continue
        file = files[path]
        old = mappings.get(path)
        exists = old is not None and any(
            t["table_id"] == old["table_id"] for t in inventories[volume])
        if exists and file["file_hash"] == old["file_hash"]:
            result["unchanged"].append(dict(old, relative_path=path))
            continue
        parts = path.split("/")
        name = build_target_table_name(path)
        action = {key: file[key] for key in (
            "absolute_path", "relative_path", "extension", "file_hash")}
        action.update(action="REPLACE" if exists else "CREATE",
                      target_folder_path="/".join(parts[:-1]), target_table_name=name)
        candidates.setdefault(volume, []).append(action)

    for volume in sorted(candidates, key=_volume_number):
        actions = candidates[volume]
        name_counts = {}
        for action in actions:
            name = action["target_table_name"]
            name_counts[name] = name_counts.get(name, 0) + 1
        accepted = []
        for action in actions:
            path, name = action["relative_path"], action["target_table_name"]
            allowed_id = mappings[path]["table_id"] if action["action"] == "REPLACE" else None
            conflict = name_counts[name] > 1 or any(
                t["table_name"] == name and t["table_id"] != allowed_id
                for t in inventories[volume])
            if conflict:
                errors.append({"error": "TARGET_TABLE_NAME_CONFLICT", "scope": "file",
                               "relative_path": path, "volume": volume})
            else:
                accepted.append(action)
        if accepted:
            result["base_queues"].append({
                "volume": volume,
                "base_name": base_name_template.format(shop_name=shop_name, volume=_volume_number(volume)),
                "actions": accepted})
    return _finish(result)
