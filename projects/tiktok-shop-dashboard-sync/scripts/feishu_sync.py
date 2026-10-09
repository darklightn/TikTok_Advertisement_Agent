"""Resource checks, key-based upsert and bounded confirmation; no delete operations."""
from collections import defaultdict
from datetime import datetime, timezone
import math
import time

from feishu_client import FeishuError
from state_store import managed_record_key

DEFAULT_FEISHU = {'cli_command': ['lark-cli'], 'identity': 'user', 'timeout_seconds': 60}
DEFAULT_SYNC = {'batch_size': 100, 'page_size': 100, 'readback_attempts': 5, 'readback_interval_seconds': 1}


def settings(config):
    f, s = dict(DEFAULT_FEISHU), dict(DEFAULT_SYNC)
    for name, dest in [('feishu', f), ('sync', s)]:
        value = config.get(name, {})
        if not isinstance(value, dict):
            raise ValueError(name + '必须为对象')
        dest.update(value)
    if not isinstance(f['cli_command'], list) or not f['cli_command'] or any(not isinstance(x, str) or not x.strip() for x in f['cli_command']):
        raise ValueError('cli_command必须为非空字符串数组')
    if f['identity'] != 'user':
        raise ValueError('阶段03使用已有user身份')
    for key, maximum in [('batch_size', 200), ('page_size', 200), ('readback_attempts', 10)]:
        if type(s[key]) is not int or not 1 <= s[key] <= maximum:
            raise ValueError(key + '超出整数范围')
    for key, value, positive in [('timeout_seconds', f['timeout_seconds'], True), ('readback_interval_seconds', s['readback_interval_seconds'], False)]:
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or positive and value == 0:
            raise ValueError(key + '不是有效时长')
    return f, s


class StopSync(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def remote_assert(condition, message):
    if not condition:
        raise FeishuError('REMOTE_INVALID_RESPONSE', message)


def all_records(client, base, table, size):
    items, seen, cursor = [], set(), None
    while True:
        page = client.list_records(base, table, page_token=cursor, page_size=size)
        remote_assert(isinstance(page, dict) and isinstance(page.get('items'), list) and type(page.get('has_more')) is bool, '记录分页返回无效')
        for row in page['items']:
            remote_assert(isinstance(row, dict) and isinstance(row.get('record_id'), str) and row['record_id'] and isinstance(row.get('fields'), dict), '记录正文无效')
        items.extend(page['items'])
        if not page['has_more']:
            return items
        cursor = page.get('page_token')
        remote_assert(isinstance(cursor, str) and cursor and cursor not in seen, '分页游标缺失或重复')
        seen.add(cursor)


def index_rows(rows):
    by = defaultdict(list)
    for row in rows:
        key = row['fields'].get('记录唯一键')
        if isinstance(key, str) and key:
            by[key].append(row)
    return by


def equal(left, right, fields, include_time=False):
    for name in fields:
        if name == '数据更新时间':
            if not include_time:
                continue
            try:
                a = datetime.fromisoformat(left[name].replace('Z', '+00:00'))
                b = datetime.fromisoformat(right[name].replace('Z', '+00:00'))
                if abs((a - b).total_seconds()) >= 0.001:
                    return False
                continue
            except (ValueError, KeyError, TypeError):
                return False
        a, b = left.get(name), right.get(name)
        if type(a) in (int, float) and type(b) in (int, float):
            if not math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12):
                return False
            continue
        if a != b:
            return False
    return True


def synchronize(client, config, table_config, state, records, run_id, scope, save_state, source_issues):
    _, tuning = settings(config)
    fields = table_config['fields']
    names = [f['name'] for f in fields]
    problems = list(source_issues)
    summary = {'candidate_count': len(records), 'inserted': 0, 'updated': 0, 'skipped': 0, 'confirmed_count': 0}
    actions, history_actions = [], []
    maintenance = {'renamed_record_count': 0, 'history_name_update_count': 0,
                   'default_repair_required': bool(state.get('default_repair'))}
    status, error, exit_code = 'ERROR', 'REMOTE_ERROR', 6
    try:
        resource = state['resources']
        base, table = resource.get('base_token'), resource.get('table_id')
        if not base:
            if scope['mode'] == 'sync':
                raise StopSync('TARGET_NOT_INITIALIZED', 'sync需要已确认的目标资源')
            parent = client.resolve_parent(config['target']['parent_folder_path'], config['target'].get('parent_folder_token'))
            remote_assert(isinstance(parent, dict) and parent.get('folder_token'), '父目录未确认')
            matches = client.find_bases(parent['folder_token'], config['target']['base_name'])
            remote_assert(isinstance(matches, list), '同名Base查询返回无效')
            if matches:
                raise StopSync('TARGET_CONFIRMATION_REQUIRED', '已有同名Base但本地未登记；需Agent确认归属')
            created = client.create_base(parent['folder_token'], config['target']['base_name'], config['target']['table_name'], fields)
            remote_assert(isinstance(created, dict) and created.get('base_token'), '创建Base未取得实际ID')
            base, table = created['base_token'], created.get('table_id')
            resource['base_token'] = base
            if table:
                resource['table_id'] = table
            save_state()
        else:
            try:
                client.get_base(base)
            except FeishuError as exc:
                if exc.code == 'REMOTE_NOT_FOUND':
                    raise StopSync('TARGET_NOT_FOUND', '已保存Base明确不存在') from exc
                raise
        tables = client.list_tables(base)
        remote_assert(isinstance(tables, list), '数据表列表返回无效')
        if table:
            if not any(t.get('table_id') == table for t in tables):
                raise StopSync('TARGET_NOT_FOUND', '已保存数据表明确不存在')
        else:
            matches = [t for t in tables if t.get('name') == config['target']['table_name']]
            if len(matches) > 1:
                raise StopSync('TARGET_CONFIRMATION_REQUIRED', '已确认Base中存在多个同名表')
            if matches:
                table = matches[0]['table_id']
            elif scope['mode'] == 'sync':
                raise StopSync('TARGET_NOT_INITIALIZED', 'sync不能新建目标表')
            else:
                table = client.create_table(base, config['target']['table_name'], fields).get('table_id')
            remote_assert(isinstance(table, str) and table, '没有取得目标表ID')
            resource['table_id'] = table
            save_state()
        actual = client.list_fields(base, table)
        remote_assert(isinstance(actual, list), '字段列表返回无效')
        by = defaultdict(list)
        for f in actual:
            remote_assert(isinstance(f, dict) and f.get('name') and f.get('field_id'), '字段无名称或ID')
            by[f['name']].append(f)
        if [f['name'] for f in actual if f.get('primary')] != ['记录唯一键'] or any(len(by[name]) > 1 for name in names):
            raise StopSync('TARGET_SCHEMA_INVALID', '主字段或受管字段名称冲突')
        missing = []
        for spec in fields:
            found = by[spec['name']]
            if not found:
                if spec.get('primary'):
                    raise StopSync('TARGET_SCHEMA_INVALID', '缺少主字段')
                missing.append(spec)
            elif found[0].get('type') != spec['type'] or spec['type'] == 'single_select' and not set(spec['options']).issubset(found[0].get('options', [])):
                raise StopSync('TARGET_SCHEMA_INVALID', '受管字段类型或单选选项冲突：' + spec['name'])
        for spec in missing:
            new = client.create_field(base, table, spec)
            remote_assert(isinstance(new, dict) and new.get('field_id') and new.get('type') == spec['type'], '补建字段返回无效')
            by[spec['name']] = [new]
        resource['field_ids'] = {name: by[name][0]['field_id'] for name in names}
        save_state()
        existing = all_records(client, base, table, tuning['page_size'])
        indexed = index_rows(existing)
        if any(len(indexed[r['记录唯一键']]) > 1 for r in records):
            raise StopSync('TARGET_DUPLICATE_KEY', '本轮候选业务键在目标中重复')
        labels = defaultdict(set)
        for r in existing:
            if r['fields'].get('店铺ID') and r['fields'].get('店铺名称'):
                labels[r['fields']['店铺ID']].add(r['fields']['店铺名称'])
        current_names = {r['店铺ID']: r['店铺名称'] for r in records}
        deferred = {identity for identity, name in current_names.items()
                    if any(other != identity and name in aliases for other, aliases in labels.items())
                    or any(other != identity and name == other_name for other, other_name in current_names.items())}
        for identity in sorted(deferred):
            problems.append({'code': 'TARGET_SHOP_NAME_CONFLICT', 'message': '目标新名称已属于另一店铺ID，未写入该店', 'shop_directory': None, 'source': None, 'period': None, 'shop_id': identity})
        records = [r for r in records if r['店铺ID'] not in deferred]
        summary['candidate_count'] = len(records)
        if not records:
            raise StopSync('TARGET_SHOP_NAME_CONFLICT', '本轮店铺目标名称均有冲突，未写入')
        current_names = {r['店铺ID']: r['店铺名称'] for r in records}
        candidate_keys = {r['记录唯一键'] for r in records}
        managed = [row for row in existing if managed_record_key(row['fields'], table_config)
                   and row['fields']['店铺ID'] in current_names]
        if any(len(indexed[row['fields']['记录唯一键']]) > 1 for row in managed):
            raise StopSync('TARGET_DUPLICATE_KEY', '受管历史业务键在目标中重复，未改名')
        history = []
        updated_at = records[0]['数据更新时间']
        for row in managed:
            old = row['fields']
            name = current_names[old['店铺ID']]
            if old['记录唯一键'] in candidate_keys or old.get('店铺名称') == name:
                continue
            item = {'key': old['记录唯一键'], 'record_id': row['record_id'],
                    'old_name': old.get('店铺名称'), 'new_name': name, 'confirmation': 'pending'}
            patch = {'店铺名称': name, '数据更新时间': updated_at}
            history.append((patch, {**old, **patch}, item))
            history_actions.append(item)
        # Persist the one saved-default repair before any possible rename write.
        from dashboard_manager import prepare_default_repair
        prepare_default_repair(client, config, state, current_names, save_state)
        maintenance['default_repair_required'] = bool(state.get('default_repair'))
        batches = {'insert': [], 'update': [], 'skip': []}
        for r in records:
            old = indexed[r['记录唯一键']]
            action = 'insert' if not old else 'skip' if equal(r, old[0]['fields'], names) else 'update'
            item = {'key': r['记录唯一键'], 'action': action, 'record_id': old[0]['record_id'] if old else None,
                    'confirmation': 'pending'}
            if old and old[0]['fields'].get('店铺名称') != r['店铺名称']:
                item.update(old_name=old[0]['fields'].get('店铺名称'), new_name=r['店铺名称'])
            actions.append(item)
            batches[action].append((r, item))
        summary['skipped'] = len(batches['skip'])
        for action in ['insert', 'update']:
            group = batches[action]
            for offset in range(0, len(group), tuning['batch_size']):
                batch = group[offset:offset + tuning['batch_size']]
                for _, item in batch:
                    item['confirmation'] = 'request_started_unconfirmed'
                if action == 'insert':
                    response = client.batch_create(base, table, [r for r, _ in batch])
                else:
                    response = client.batch_update(base, table, {item['record_id']: r for r, item in batch})
                remote_assert(isinstance(response, dict) and not response.get('ignored_fields'), '写入忽略了字段或响应无效')
                if action == 'insert':
                    remote_assert(isinstance(response.get('record_ids'), list) and len(response['record_ids']) == len(batch)
                                  and all(isinstance(x, str) and x for x in response['record_ids']), '新增响应未完整返回ID')
                summary['inserted' if action == 'insert' else 'updated'] += len(batch)
                for _, item in batch:
                    item['confirmation'] = 'response_received_pending_readback'
        for offset in range(0, len(history), tuning['batch_size']):
            batch = history[offset:offset + tuning['batch_size']]
            for _, _, item in batch:
                item['confirmation'] = 'request_started_unconfirmed'
            response = client.batch_update(base, table, {item['record_id']: patch for patch, _, item in batch})
            remote_assert(isinstance(response, dict) and not response.get('ignored_fields'), '历史名称写入忽略字段或响应无效')
            for _, _, item in batch:
                item['confirmation'] = 'response_received_pending_readback'
        for attempt in range(tuning['readback_attempts']):
            reread = index_rows(all_records(client, base, table, tuning['page_size']))
            good = []
            for r, item in zip(records, actions):
                rows = reread[r['记录唯一键']]
                if len(rows) > 1:
                    raise StopSync('TARGET_DUPLICATE_KEY', '回读发现候选业务键重复')
                if len(rows) == 1 and equal(r, rows[0]['fields'], names, include_time=item['action'] != 'skip') and (item['record_id'] is None or rows[0]['record_id'] == item['record_id']):
                    good.append((item, rows[0]['record_id']))
            history_good = []
            for _, expected, item in history:
                rows = reread[item['key']]
                if len(rows) > 1:
                    raise StopSync('TARGET_DUPLICATE_KEY', '回读发现历史业务键重复')
                if (len(rows) == 1 and rows[0]['record_id'] == item['record_id']
                        and equal(expected, rows[0]['fields'], expected, include_time=True)):
                    history_good.append(item)
            for item, rid in good:
                item.update(record_id=rid, confirmation='confirmed')
            for item in history_good:
                item['confirmation'] = 'confirmed'
            maintenance['history_name_update_count'] = len(history_good)
            maintenance['renamed_record_count'] = len(history_good) + sum('new_name' in item for item, _ in good)
            if len(good) == len(records) and len(history_good) == len(history):
                break
            if attempt + 1 < tuning['readback_attempts']:
                time.sleep(tuning['readback_interval_seconds'])
        else:
            raise StopSync('READBACK_MISMATCH', '有限回读后候选或历史名称、ID、数值仍不一致，未保存同步成功')
        for item, rid in good:
            item.update(record_id=rid, confirmation='confirmed')
            state.setdefault('records', {})[item['key']] = rid
        for item in history_good:
            state.setdefault('records', {})[item['key']] = item['record_id']
        summary['confirmed_count'] = len(good)
        status, error, exit_code = ('PARTIAL_SYNCED', 'SYNC_PARTIAL', 5) if problems else ('DATA_SYNCED', None, 0)
        if status == 'DATA_SYNCED':
            state['last_data_sync'] = {'run_id': run_id, 'status': status, 'confirmed_count': len(good),
                                      'scope': scope['scope'], 'completed_at': datetime.now(timezone.utc).isoformat()}
        save_state()
    except StopSync as exc:
        status, error, exit_code = ('ERROR', exc.code, 6) if exc.code == 'READBACK_MISMATCH' else ('BLOCKED', exc.code, 4)
        problems.append({'code': exc.code, 'message': str(exc), 'shop_directory': None, 'source': None, 'period': None})
    except FeishuError as exc:
        problems.append({'code': exc.code, 'message': str(exc), 'shop_directory': None, 'source': None, 'period': None})
    return {'status': status, 'error_code': error, 'exit_code': exit_code, 'sync_summary': summary,
            'maintenance_summary': maintenance, 'history_name_actions': history_actions, 'actions': actions, 'issues': problems}
