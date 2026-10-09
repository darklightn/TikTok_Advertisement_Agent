"""Dashboard initialization and Agent browser handoff on confirmed data."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
import uuid

from feishu_client import FeishuError
from feishu_sync import settings
from state_store import SKILL, write_json

CHECKS = ['shop_single_select', 'period_single_select', 'defaults_saved', 'all_components_linked',
          'product_view_relationship', 'product_formats_visible', 'units_visible', 'aov_note_visible',
          'selection_notice_visible', 'shop_switch_confirmed', 'period_switch_confirmed',
          'refresh_confirmed', 'layout_readable']
REPAIR_CHECKS = ['saved_shop_default_updated', 'saved_period_default_unchanged',
                 'component_ids_unchanged', 'refresh_confirmed']


class PageError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def ensure(value, code, message):
    if not value:
        raise PageError(code, message)


def page_initialized(state):
    d, r = state.get('dashboard', {}), state['resources']
    return (state['initialized'] and d.get('browser_confirmed') is True and r.get('base_token')
            and r.get('table_id') and r.get('dashboard_id') and len(d.get('cards', {})) == 10
            and d.get('product_block_id') and d.get('product_view_id')
            and set(d.get('slicers', {})) == {'店铺名称', '统计区间'} and state.get('defaults'))


def card_config(table_name, spec):
    return {'table_name': table_name, 'series': [{'field_name': spec['field'], 'rollup': 'SUM'}],
            'filter': {'conjunction': 'and', 'conditions': [{'field_name': '记录类型', 'operator': 'is', 'value': '店铺汇总'}]},
            'number_format': {'formatName': 'percentage_rounded' if spec['format'] == 'percent' else 'digital', 'precision': spec['precision']}}


def card_matches(block, spec, desired):
    cfg = deepcopy(block.get('data_config', {}))
    for c in cfg.get('filter', {}).get('conditions', []):
        if c.get('field_name') == '记录类型' and isinstance(c.get('value'), list) and len(c['value']) == 1:
            c['value'] = c['value'][0]
    return (block.get('name') == spec['title'] and block.get('type') == 'statistics'
            and not cfg.get('count_all') and not cfg.get('group_by')
            and all(cfg.get(k) == v for k, v in desired.items()))


def view_matches(actual, spec):
    columns = [x for x in actual.get('columns', []) if x != '记录唯一键']
    return (columns == spec['columns'] and actual.get('sort') == spec['sort']
            and not actual.get('group_by') and actual.get('fixed_filter') == spec['fixed_filter'])


def choose_default(records, requested):
    rows = [r for r in records if r['记录类型'] == '店铺汇总']
    if requested is not None:
        rows = [r for r in rows if r['店铺名称'] == requested]
    ensure(rows, 'DEFAULT_SELECTION_INVALID', '默认店铺必须来自本轮已确认有效范围')
    shop = sorted(rows, key=lambda r: (r['店铺ID'], r['店铺名称']))[0]
    rows = [r for r in rows if r['店铺ID'] == shop['店铺ID']]
    rows.sort(key=lambda r: r['统计开始日期'])
    rows.sort(key=lambda r: r['统计结束日期'], reverse=True)
    row = rows[0]
    return {'shop_id': row['店铺ID'], 'shop_name': row['店铺名称'],
            'period': {'start_date': row['统计开始日期'], 'end_date': row['统计结束日期'], 'label': row['统计区间']}}


def dashboard_url(base_url, base, did):
    parts = urlsplit(base_url or '')
    ensure(parts.scheme == 'https' and parts.netloc and base in parts.path,
           'PAGE_CONFIRMATION_REQUIRED', '官方返回未提供可确认的Base访问地址')
    query = {k: v for k, v in parse_qsl(parts.query) if k not in ['table', 'view', 'record', 'dashboard']}
    # Feishu's dashboard sidebar opens the actual dashboard ID in the table route.
    query['table'] = did
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ''))


def read_receipt(path, task, repair=False):
    try:
        receipt = json.loads(Path(path).read_text(encoding='utf-8-sig'))
        target = {k: task['target'][k] for k in ['base_token', 'table_id', 'dashboard_id']}
        assert type(receipt['result_version']) is int and receipt['result_version'] == 1
        assert receipt['task_id'] == task['task_id'] and receipt['target'] == target
        assert receipt['defaults'] == task['defaults']
        assert all(receipt['checks'].get(k) is True for k in (REPAIR_CHECKS if repair else CHECKS))
        if repair:
            assert receipt['kind'] == 'repair_default_shop'
            assert receipt['components'] == task['components']
        ids = [receipt['components']['product']['block_id'], *receipt['components']['slicers'].values()]
        assert set(receipt['components']['slicers']) == {'店铺名称', '统计区间'}
        assert len(ids) == 3 and len(set(ids)) == 3 and all(isinstance(i, str) and i for i in ids)
        assert isinstance(receipt['components']['product']['view_id'], str) and receipt['components']['product']['view_id']
        images = receipt['screenshots']
        assert isinstance(images, list) and len(set(images)) >= 2
        assert all(Path(p).is_absolute() and Path(p).is_file() and Path(p).stat().st_size > 0 for p in images)
        assert datetime.fromisoformat(receipt['completed_at'].replace('Z', '+00:00')).tzinfo is not None
        return receipt
    except (OSError, ValueError, KeyError, TypeError, AttributeError, AssertionError) as exc:
        raise PageError('BROWSER_RESULT_INVALID', '网页回执缺失或任务、目标、默认值、检查与截图不符') from exc


def prepare_default_repair(client, config, state, current_names, save):
    """Keep one durable intent before data writes, including a data-only rename."""
    if not page_initialized(state):
        return
    previous = state['defaults']
    name = current_names.get(previous['shop_id'])
    if name is None:
        return
    pending = state.get('default_repair')
    if pending:
        if pending.get('defaults', {}).get('shop_name') != name or pending.get('previous_defaults') != previous:
            raise FeishuError('DEFAULT_REPAIR_CONFIRMATION_REQUIRED', '已有改名待办与当前来源不符，请Agent核对后继续')
        return
    if previous['shop_name'] == name:
        return
    r, page = state['resources'], state['dashboard']
    base_info = client.get_base(r['base_token'])
    defaults = deepcopy(previous)
    defaults['shop_name'] = name
    state['default_repair'] = {'task_id': uuid.uuid4().hex, 'kind': 'repair_default_shop',
        'target': {**{k:r[k] for k in ['base_token','table_id','dashboard_id']},
                   'table_name':config['target']['table_name'],
                   'url':dashboard_url(base_info.get('url'),r['base_token'],r['dashboard_id'])},
        'previous_defaults':deepcopy(previous), 'defaults':defaults,
        'components':{'product':{'block_id':page['product_block_id'],'view_id':page['product_view_id']},
                      'slicers':deepcopy(page['slicers'])}}
    save()


def check_web(client, base, table, did, table_name, components, spec, tuning, allow_configure, error_code):
    try:
        product = components['product']
        block = client.get_dashboard_block(base, did, product['block_id'])
        ensure(block.get('type') == 'view' and block.get('data_config', {}).get('table_name') == table_name,
               error_code, '商品组件类型或底表不符')
        for field, bid in components['slicers'].items():
            block = client.get_dashboard_block(base, did, bid)
            cfg = block.get('data_config', {})
            ensure(block.get('type') == 'slicer' and cfg.get('table_name') == table_name
                   and [x.get('field_name') for x in cfg.get('group_by', [])] == [field], error_code, '切片器底表或字段不符')
        actual = client.get_product_view(base, table, product['view_id'])
        ensure(actual.get('view_id') == product['view_id'] and actual.get('table_id') == table,
               error_code, '商品视图不属于目标底表')
        if not view_matches(actual, spec) and allow_configure:
            client.configure_product_view(base, table, product['view_id'], spec)
        for attempt in range(tuning['readback_attempts']):
            if view_matches(actual, spec):
                return
            if attempt:
                time.sleep(tuning['readback_interval_seconds'])
            actual = client.get_product_view(base, table, product['view_id'])
        ensure(view_matches(actual, spec), 'PAGE_READBACK_MISMATCH', '商品视图配置有限回读后仍不一致')
    except FeishuError as exc:
        if exc.code == 'REMOTE_NOT_FOUND':
            raise PageError(error_code, '网页组件或底层视图无法确认') from exc
        raise


def manage(client, config, definition, state, records, mode, requested, receipt_path, output_dir, run_id, scope, issues, save):
    _, tuning = settings(config)
    problems = list(issues)
    artifacts, actions = {}, []
    result = {'status': 'ERROR', 'error_code': 'REMOTE_ERROR', 'exit_code': 6,
              'message': '页面处理未完成，请查看问题与本轮证据。'}
    page = state.setdefault('dashboard', {})
    try:
        resources = state['resources']
        base, table = resources['base_token'], resources['table_id']
        existing_ready = bool(page_initialized(state))
        if state.get('defaults'):
            ensure(requested is None or requested == state['defaults'].get('shop_name'),
                   'DEFAULT_SELECTION_INVALID', '已保存默认值或网页待办；不能用重跑静默更换默认店铺')
        else:
            state['defaults'] = choose_default(records, requested)
            save()
        did = resources.get('dashboard_id')
        if did:
            try:
                client.get_dashboard(base, did)
            except FeishuError as exc:
                if exc.code == 'REMOTE_NOT_FOUND':
                    raise PageError('PAGE_CONFIRMATION_REQUIRED', '已保存仪表盘ID失效，未新建替代') from exc
                raise
        else:
            matches = [x for x in client.list_dashboards(base) if x['name'] == config['target']['dashboard_name']]
            ensure(len(matches) <= 1, 'PAGE_CONFIRMATION_REQUIRED', '同名仪表盘存在歧义')
            did = matches[0]['dashboard_id'] if matches else client.create_dashboard(base, config['target']['dashboard_name'])['dashboard_id']
            resources['dashboard_id'] = did
            save()
        base_info = client.get_base(base)
        url = dashboard_url(base_info.get('url'), base, did)
        blocks = client.list_dashboard_blocks(base, did)
        by_id = {x['block_id']: x for x in blocks}
        cards = page.setdefault('cards', {})
        selections = []
        for spec in definition['cards']:
            found = [x for x in blocks if x.get('name') == spec['title'] or
                     any(y.get('field_name') == spec['field'] for y in x.get('data_config', {}).get('series', []))]
            saved = cards.get(spec['field'])
            if saved:
                ensure(saved in by_id, 'PAGE_CONFIRMATION_REQUIRED', '已保存指标卡不存在')
                if by_id[saved] not in found:
                    found.append(by_id[saved])
            ensure(len(found) <= 1, 'PAGE_CONFIRMATION_REQUIRED', '指标卡存在多个同名或同字段候选')
            if found:
                ensure(found[0].get('type') == 'statistics' and found[0].get('data_config', {}).get('table_name') == config['target']['table_name'],
                       'PAGE_CONFIRMATION_REQUIRED', '候选指标卡类型或数据源冲突')
            ensure(found or not existing_ready, 'PAGE_CONFIRMATION_REQUIRED', '已完成页面缺少受管卡，需核对')
            selections.append((spec, found[0] if found else None))
        for spec, block in selections:
            desired = card_config(config['target']['table_name'], spec)
            if block is None:
                bid = client.create_dashboard_block(base, did, spec['title'], 'statistics', desired)['block_id']
                cards[spec['field']] = bid
                actions.append({'action': 'create_card', 'field': spec['field'], 'block_id': bid})
                save()
                block = client.get_dashboard_block(base, did, bid)
            else:
                bid = block['block_id']
                cards[spec['field']] = bid
                save()
                block = client.get_dashboard_block(base, did, bid)
            if not card_matches(block, spec, desired) and not existing_ready:
                client.update_dashboard_block(base, did, bid, spec['title'], desired)
                actions.append({'action': 'configure_card', 'field': spec['field'], 'block_id': bid})
            for attempt in range(tuning['readback_attempts']):
                if card_matches(block, spec, desired):
                    break
                if attempt:
                    time.sleep(tuning['readback_interval_seconds'])
                block = client.get_dashboard_block(base, did, bid)
            ensure(card_matches(block, spec, desired), 'PAGE_READBACK_MISMATCH', '指标卡配置有限回读后仍不一致：' + spec['field'])
        if not existing_ready:
            texts = {
                '看板阅读说明': '\n\n'.join(definition['notes'].values()),
                '01｜整体经营（金额单位：PHP）': '## 01｜整体经营（金额单位：PHP）',
                '02｜广告表现（金额单位：USD）': '## 02｜广告表现（金额单位：USD）',
                '03｜商品表现': '## 03｜商品表现',
            }
            text_ids = page.setdefault('texts', {})
            for title, body in texts.items():
                found = [b for b in blocks if b.get('name') == title]
                ensure(len(found) <= 1 and all(b.get('type') == 'text' for b in found),
                       'PAGE_CONFIRMATION_REQUIRED', '模块标题或说明存在歧义')
                if found:
                    bid = found[0]['block_id']
                else:
                    bid = client.create_dashboard_block(base, did, title, 'text', {'text': body})['block_id']
                    actions.append({'action': 'create_text', 'block_id': bid, 'name': title})
                text_ids[title] = bid
                save()
        if existing_ready:
            components = {'product': {'block_id': page['product_block_id'], 'view_id': page['product_view_id']}, 'slicers': page['slicers']}
            pending = state.get('default_repair')
            check_web(client, base, table, did, config['target']['table_name'], components, definition['product_view'], tuning, False,
                      'BROWSER_RESULT_INVALID' if pending and receipt_path else 'PAGE_CONFIRMATION_REQUIRED')
            if pending:
                ensure(pending['previous_defaults'] == state['defaults'] and pending['components'] == components
                       and all(pending['target'][k] == resources[k] for k in ['base_token','table_id','dashboard_id']),
                       'BROWSER_RESULT_INVALID', '默认修复待办与原登记不符')
                task = {'task_version':1, 'skill':SKILL, **deepcopy(pending), 'required_checks':REPAIR_CHECKS,
                        'actions':['打开原店铺切片器的已保存默认值设置，仅将旧店名改成同ID新名称',
                                   '保持原默认统计区间、单选、关联范围、组件ID及布局',
                                   '保存后重新打开页面核对，保留设置与重开截图；用完整sync携回执续跑']}
                task_path = output_dir / 'browser_task.json'
                write_json(task_path, task)
                artifacts['browser_task_json'] = str(task_path)
                if receipt_path is None:
                    result.update(status='BROWSER_REQUIRED',error_code='DEFAULT_REPAIR_REQUIRED',exit_code=7,
                                  message='历史名称已确认；Agent请修复原切片器的已保存默认店名，保留原区间，再携回执续跑。')
                    return finish_report(result,page,artifacts,actions,problems,output_dir,run_id)
                receipt = read_receipt(receipt_path,task,repair=True)
                receipt_copy = output_dir / 'browser_result.json'
                write_json(receipt_copy,receipt)
                artifacts['browser_result_json'] = str(receipt_copy)
                state['defaults'] = deepcopy(pending['defaults'])
                page['default_repair_result_json'] = str(receipt_copy)
                state.pop('default_repair')
                save()
        else:
            target = {'base_token': base, 'table_id': table, 'dashboard_id': did, 'table_name': config['target']['table_name'], 'url': url}
            context = {'target': target, 'defaults': state['defaults'], 'definition': definition, 'cards': cards}
            signature = hashlib.sha256(json.dumps(context, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            ensure(not page.get('pending_task_id') or page.get('pending_signature') == signature,
                   'PAGE_CONFIRMATION_REQUIRED', '网页待办目标、默认值或定义已变更，需核对现有页面')
            task_id = page.get('pending_task_id') or uuid.uuid4().hex
            task = {'task_version': 1, 'skill': SKILL, 'task_id': task_id, 'target': target,
                    'field_ids': resources['field_ids'], 'cards': cards, 'texts': page.get('texts', {}), 'defaults': state['defaults'],
                    **{k: definition[k] for k in ['modules', 'product_view', 'slicers', 'notes']},
                    'actions': ['正常网页创建或复用商品view组件并确认底层view_id', '设置六列、固定商品结果筛选、GMV降序与百分比格式',
                                '创建或复用两个下拉单选切片器并关联11个业务组件', '保存默认组合，检查单位、AOV、清空说明、联动、刷新和布局',
                                '保存真实截图和browser_result.json，由同一init入口续跑'], 'required_checks': CHECKS}
            task_path = output_dir / 'browser_task.json'
            write_json(task_path, task)
            artifacts['browser_task_json'] = str(task_path)
            page.update(pending_task_id=task_id, pending_signature=signature, pending_task_json=str(task_path))
            save()
            if receipt_path is None:
                result.update(status='BROWSER_REQUIRED', error_code='BROWSER_SETUP_REQUIRED', exit_code=7,
                              message='底表和十卡已确认；Agent请继续本轮网页待办，再携带实际回执续跑。')
                return finish_report(result, page, artifacts, actions, problems, output_dir, run_id)
            receipt = read_receipt(receipt_path, task)
            check_web(client, base, table, did, config['target']['table_name'], receipt['components'], definition['product_view'], tuning, True, 'BROWSER_RESULT_INVALID')
            receipt_copy = output_dir / 'browser_result.json'
            write_json(receipt_copy, receipt)
            artifacts['browser_result_json'] = str(receipt_copy)
            page.update(product_block_id=receipt['components']['product']['block_id'], product_view_id=receipt['components']['product']['view_id'],
                        slicers=receipt['components']['slicers'], browser_confirmed=True, confirmed_task_id=task_id,
                        browser_result_json=str(receipt_copy), pending_task_id=None, pending_signature=None)
            state['initialized'] = True
            save()
        result.update(status='PAGE_PARTIAL' if problems else 'PAGE_READY', error_code='SYNC_PARTIAL' if problems else None,
                      exit_code=5 if problems else 0, dashboard_url=url,
                      message='老板看板已完成页面确认；部分来源问题请查看issues。' if problems else '老板看板数据和页面已确认，可打开并切换店铺与统计区间。')
        if not problems:
            state['last_successful_sync'] = {'run_id': run_id, 'status': 'PAGE_READY', 'scope': scope, 'completed_at': datetime.now(timezone.utc).isoformat()}
        save()
    except PageError as exc:
        result.update(status='ERROR' if exc.code == 'PAGE_READBACK_MISMATCH' else 'BLOCKED', error_code=exc.code,
                      exit_code=6 if exc.code == 'PAGE_READBACK_MISMATCH' else 4, message=str(exc))
        problems.append({'code': exc.code, 'message': str(exc)})
    except FeishuError as exc:
        problems.append({'code': exc.code, 'message': str(exc)})
    return finish_report(result, page, artifacts, actions, problems, output_dir, run_id)


def finish_report(result, page, artifacts, actions, issues, output_dir, run_id):
    result.update(page_summary={'card_count': len(page.get('cards', {})), 'product_count': int(bool(page.get('product_block_id'))),
                                'slicer_count': len(page.get('slicers', {})), 'browser_confirmed': page.get('browser_confirmed') is True}, issues=issues)
    report = output_dir / 'page_report.json'
    write_json(report, {'run_id': run_id, **result, 'actions': actions})
    artifacts['page_report_json'] = str(report)
    result['artifacts'] = artifacts
    return result
