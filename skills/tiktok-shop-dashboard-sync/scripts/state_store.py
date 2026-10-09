"""Independent local preflight state and single-machine run lock."""
import json
import os
from copy import deepcopy
from datetime import date, datetime, timezone
from pathlib import Path
import uuid

SKILL = 'tiktok-shop-dashboard-sync'


class RunLocked(Exception):
    pass


class StateInvalid(Exception):
    pass


class RecoveryError(Exception):
    def __init__(self, code, message, exit_code=4):
        self.code = code
        self.exit_code = exit_code
        super().__init__(message)


def managed_record_key(fields, table_config):
    """Return a key only when the two managed record identities agree with it."""
    try:
        kind = fields['记录类型']
        if kind not in ('店铺汇总', '商品结果'):
            return None
        identity = fields['店铺ID']
        start, end = fields['统计开始日期'], fields['统计结束日期']
        if not isinstance(identity, str) or not identity.strip() or '|' in identity:
            return None
        if not all(isinstance(x, str) and date.fromisoformat(x).isoformat() == x for x in (start, end)) or start > end:
            return None
        product = fields.get('商品ID')
        if kind == '商品结果' and (not isinstance(product, str) or not product.strip() or '|' in product):
            return None
        expected = table_config['keys'][kind].format(shop_id=identity, start_date=start, end_date=end, product_id=product)
        return expected if fields.get('记录唯一键') == expected else None
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def _recovery_receipt(path, definition):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8-sig'))
        assert type(value['recovery_version']) is int and value['recovery_version'] == 1
        assert value['skill'] == SKILL
        target, components, defaults = value['target'], value['components'], value['defaults']
        assert set(target) == {'base_token', 'table_id', 'dashboard_id'}
        assert all(isinstance(x, str) and x.strip() for x in target.values())
        assert set(components['cards']) == {c['field'] for c in definition['cards']}
        assert set(components['slicers']) == {'店铺名称', '统计区间'}
        product = components['product']
        ids = [*components['cards'].values(), *components['slicers'].values(), product['block_id']]
        assert len(ids) == 13 and all(isinstance(x, str) and x.strip() for x in ids) and len(set(ids)) == 13
        assert isinstance(product['view_id'], str) and product['view_id'].strip()
        assert set(defaults) == {'shop_id', 'shop_name', 'period'}
        assert all(isinstance(defaults[k], str) and defaults[k].strip() for k in ['shop_id', 'shop_name'])
        period = defaults['period']
        assert set(period) == {'start_date', 'end_date', 'label'}
        assert all(isinstance(period[k], str) and period[k].strip() for k in period)
        assert all(date.fromisoformat(period[k]).isoformat() == period[k] for k in ['start_date', 'end_date'])
        assert period['start_date'] <= period['end_date']
        assert all(value['checks'].get(k) is True for k in ['target_confirmed', 'saved_defaults_confirmed', 'page_readable'])
        completed = datetime.fromisoformat(value['completed_at'].replace('Z', '+00:00'))
        assert completed.tzinfo is not None and completed.utcoffset() is not None
        images = value['screenshots']
        assert isinstance(images, list) and len(images) >= 2
        assert all(isinstance(p, str) and Path(p).is_absolute() and Path(p).is_file() and Path(p).stat().st_size > 0 for p in images)
        assert len({str(Path(p).resolve()).casefold() for p in images}) >= 2
        return value
    except (OSError, ValueError, KeyError, TypeError, AttributeError, AssertionError) as exc:
        raise RecoveryError('RECOVERY_INVALID', '恢复确认缺项、类型、Agent核对、时间或实际截图不符') from exc


def recover_state(client, config, table_config, definition, confirmation_path):
    """Read and verify an Agent-confirmed target; return state without saving or writing remotely."""
    from feishu_client import FeishuError
    from feishu_sync import all_records, index_rows, remote_assert, settings
    from dashboard_manager import card_config, card_matches, view_matches

    receipt = _recovery_receipt(confirmation_path, definition)
    target, components, defaults = receipt['target'], receipt['components'], receipt['defaults']
    base, table, did = (target[k] for k in ['base_token', 'table_id', 'dashboard_id'])
    expected = config['target']

    def confirmed(ok, message):
        if not ok:
            raise RecoveryError('RECOVERY_CONFIRMATION_REQUIRED', message)

    try:
        _, tuning = settings(config)
        parent = client.resolve_parent(expected['parent_folder_path'], expected.get('parent_folder_token'))
        remote_assert(isinstance(parent, dict) and isinstance(parent.get('folder_token'), str) and parent['folder_token'], '恢复父目录返回无效')
        matches = client.find_bases(parent['folder_token'], expected['base_name'])
        remote_assert(isinstance(matches, list) and all(isinstance(x, dict) for x in matches), '恢复目录查询返回无效')
        confirmed(any(x.get('base_token') == base and x.get('name') == expected['base_name'] for x in matches), '提供的Base不在已确认父目录的同名查询结果中')
        info = client.get_base(base)
        remote_assert(isinstance(info, dict), '恢复Base信息返回无效')
        confirmed(info.get('base_token') == base and info.get('name') == expected['base_name']
                  and info.get('folder_token') in (None, parent['folder_token']), '实际Base名称或父目录不符')
        tables = client.list_tables(base)
        remote_assert(isinstance(tables, list) and all(isinstance(x, dict) for x in tables), '恢复表列表返回无效')
        confirmed(len([x for x in tables if x.get('table_id') == table and x.get('name') == expected['table_name']]) == 1, '目标表ID或名称不符')
        fields = client.list_fields(base, table)
        remote_assert(isinstance(fields, list) and all(isinstance(f, dict) and isinstance(f.get('field_id'), str) and f['field_id'] and isinstance(f.get('name'), str) for f in fields), '恢复字段列表返回无效')
        confirmed([f['name'] for f in fields if f.get('primary')] == ['记录唯一键'], '目标主字段不符')
        field_ids = {}
        for spec in table_config['fields']:
            found = [f for f in fields if f['name'] == spec['name']]
            confirmed(len(found) == 1 and found[0].get('type') == spec['type'], '缺少受管字段或类型/名称冲突：' + spec['name'])
            if spec['type'] == 'single_select':
                confirmed(isinstance(found[0].get('options'), list) and set(spec['options']).issubset(found[0]['options']), '受管单选选项不符：' + spec['name'])
            field_ids[spec['name']] = found[0]['field_id']
        confirmed(len(set(field_ids.values())) == len(field_ids), '受管字段ID重复')

        dashboard = client.get_dashboard(base, did)
        remote_assert(isinstance(dashboard, dict), '恢复仪表盘返回无效')
        confirmed(dashboard.get('dashboard_id') == did and dashboard.get('name') == expected['dashboard_name'], '仪表盘ID或名称不符')
        blocks = client.list_dashboard_blocks(base, did)
        remote_assert(isinstance(blocks, list) and all(isinstance(b, dict) and isinstance(b.get('block_id'), str) for b in blocks), '恢复组件列表返回无效')
        listed = {b['block_id'] for b in blocks}
        for spec in definition['cards']:
            bid = components['cards'][spec['field']]
            confirmed(bid in listed, '指标卡不属于目标仪表盘')
            block = client.get_dashboard_block(base, did, bid)
            confirmed(block.get('block_id') == bid and card_matches(block, spec, card_config(expected['table_name'], spec)), '指标卡字段、类型、表、筛选或格式不符：' + spec['field'])
        product = components['product']
        confirmed(product['block_id'] in listed, '商品组件不属于目标仪表盘')
        block = client.get_dashboard_block(base, did, product['block_id'])
        cfg = block.get('data_config', {})
        confirmed(block.get('block_id') == product['block_id'] and block.get('type') == 'view' and cfg.get('table_name') == expected['table_name'], '商品组件类型或底表不符')
        if cfg.get('view_id') is not None:
            confirmed(cfg['view_id'] == product['view_id'], '商品组件与底层视图ID不符')
        for field, bid in components['slicers'].items():
            confirmed(bid in listed, '切片器不属于目标仪表盘')
            block = client.get_dashboard_block(base, did, bid)
            cfg = block.get('data_config', {})
            grouping = cfg.get('group_by')
            confirmed(block.get('block_id') == bid and block.get('type') == 'slicer' and cfg.get('table_name') == expected['table_name']
                      and isinstance(grouping, list) and len(grouping) == 1 and isinstance(grouping[0], dict)
                      and grouping[0].get('field_name') == field, '切片器类型、底表或绑定字段不符')
        view = client.get_product_view(base, table, product['view_id'])
        confirmed(view.get('view_id') == product['view_id'] and view.get('table_id') == table and view_matches(view, definition['product_view']), '商品视图归属或列、筛选、排序、分组不符')

        rows = all_records(client, base, table, tuning['page_size'])
        indexed = index_rows(rows)
        records, valid_summaries = {}, []
        for row in rows:
            f = row['fields']
            key = managed_record_key(f, table_config)
            if key is None:
                continue
            confirmed(len(indexed[key]) == 1 and row['record_id'] not in records.values(), '受管唯一键或实际record_id冲突')
            records[key] = row['record_id']
            if f['记录类型'] == '店铺汇总':
                valid_summaries.append(f)
        period = defaults['period']
        confirmed(any(f.get('店铺ID') == defaults['shop_id'] and f.get('店铺名称') == defaults['shop_name']
                      and f.get('统计开始日期') == period['start_date'] and f.get('统计结束日期') == period['end_date']
                      and f.get('统计区间') == period['label'] for f in valid_summaries), '原已保存默认组合没有对应的有效远程汇总记录')
        return {'state_version': 1, 'skill': SKILL, 'initialized': True,
                'resources': {'base_token': base, 'table_id': table, 'dashboard_id': did, 'field_ids': field_ids},
                'records': records, 'dashboard': {'cards': deepcopy(components['cards']), 'product_block_id': product['block_id'],
                'product_view_id': product['view_id'], 'slicers': deepcopy(components['slicers']), 'browser_confirmed': True},
                'defaults': deepcopy(defaults), 'last_recovery': {'completed_at': datetime.now(timezone.utc).isoformat(),
                'confirmation_json': str(Path(confirmation_path).resolve()), 'agent_completed_at': receipt['completed_at']}}
    except FeishuError as exc:
        if exc.code in ('REMOTE_NOT_FOUND', 'REMOTE_PARENT_UNCONFIRMED'):
            raise RecoveryError('RECOVERY_CONFIRMATION_REQUIRED', '恢复目标、父目录或组件无法确认；未新建替代') from exc
        raise RecoveryError('REMOTE_ERROR', '恢复只读查询失败或分页不完整；未保存恢复成功', 6) from exc


class LocalRunLock:
    def __init__(self, runtime_root):
        self.path = Path(runtime_root) / 'state' / 'run.lock'
        self.owner = uuid.uuid4().hex
        self.held = False

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            handle = self.path.open('x', encoding='utf-8')
        except FileExistsError as exc:
            raise RunLocked('已有本地任务持有运行锁；未抢占或删除。') from exc
        self.held = True
        try:
            with handle:
                json.dump({'pid': os.getpid(), 'owner': self.owner}, handle)
        except BaseException:
            self.path.unlink(missing_ok=True)
            self.held = False
            raise
        return self

    def __exit__(self, *args):
        if self.held:
            try:
                current = json.loads(self.path.read_text(encoding='utf-8'))
                if current.get('owner') == self.owner:
                    self.path.unlink()
            finally:
                self.held = False


def read_state(runtime_root):
    path = Path(runtime_root) / 'state' / 'state.json'
    if not path.exists():
        return {'state_version': 1, 'skill': SKILL, 'initialized': False, 'resources': {}}
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(value, dict) or type(value.get('state_version')) is not int
                or value['state_version'] != 1 or value.get('skill') != SKILL
                or type(value.get('initialized')) is not bool
                or not isinstance(value.get('resources'), dict)):
            raise ValueError('state结构或版本不支持')
        return value
    except (ValueError, UnicodeError) as exc:
        raise StateInvalid('本地state无效；原文件保留。') from exc


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
