"""Preflight, candidate build, data sync and Agent-assisted dashboard init."""
import sys
sys.dont_write_bytecode = True
import argparse
from datetime import date, datetime, timezone
import os
from pathlib import Path
import re
import json
import uuid

import yaml
from state_store import SKILL, LocalRunLock, RunLocked, StateInvalid, read_state, write_json

ROOT = Path(__file__).resolve().parent.parent
SUMMARY = ['GMV', '订单数', '客户数', 'AOV', '退款金额率', '广告消耗', '广告收入', '实际ROI', '广告订单', '平均下单成本']
PRODUCT = ['商品ID', '商品名称', '商品GMV', '商品订单数', '商品实际ROI', '商品退款金额率']
COMMON = ['记录唯一键', '记录类型', '店铺ID', '店铺名称', '统计开始日期', '统计结束日期', '统计区间', '店铺币种', '广告币种', '数据更新时间']
TYPES = ['店铺汇总', '商品结果']


class Failure(Exception):
    def __init__(self, code, message, status='ERROR', exit_code=2):
        super().__init__(message)
        self.code, self.status, self.exit_code = code, status, exit_code


def require(condition, where):
    if not condition:
        raise Failure('CONFIG_INVALID', '配置不符合阶段01契约：' + where)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Failure('ARGUMENT_ERROR', message)


def arguments():
    p = Parser(description='老板看板预检、构建、底表同步与完整初始化', allow_abbrev=False)
    p.add_argument('--mode', required=True, choices=['init', 'sync'])
    offline = p.add_mutually_exclusive_group()
    offline.add_argument('--check-only', action='store_true')
    offline.add_argument('--build-only', action='store_true')
    offline.add_argument('--data-only', action='store_true')
    p.add_argument('--config', default=str(ROOT / 'config' / 'sync.yaml'))
    p.add_argument('--shop', action='append', default=[])
    p.add_argument('--all', action='store_true')
    p.add_argument('--default-shop')
    p.add_argument('--browser-result')
    p.add_argument('--recover-state')
    for name in ['start-date', 'end-date', 'data-root', 'upstream-state-root', 'runtime-root']:
        p.add_argument('--' + name)
    args = p.parse_args()
    only = args.check_only or args.build_only or args.data_only
    if args.recover_state is not None and (args.mode != 'sync' or only or args.default_shop is not None or args.browser_result is not None):
        raise Failure('ARGUMENT_ERROR', '--recover-state仅用于完整sync，不能混用only、默认店或网页回执')
    if args.default_shop is not None and (args.mode != 'init' or only or args.browser_result is not None):
        raise Failure('ARGUMENT_ERROR', '--default-shop仅用于完整init，不能混用网页回执')
    if args.browser_result is not None and only:
        raise Failure('ARGUMENT_ERROR', '网页回执不能与only标志混用')
    if args.default_shop is not None:
        args.default_shop = args.default_shop.strip()
        if not args.default_shop:
            raise Failure('ARGUMENT_ERROR', '默认店铺名称不能为空')
    return args


def normalize(a):
    if a.all and a.shop:
        raise Failure('ARGUMENT_ERROR', '--all与--shop不能同时使用')
    shops = list(dict.fromkeys(s.strip() for s in a.shop))
    if '' in shops:
        raise Failure('ARGUMENT_ERROR', '店铺名称不能为空')
    period = None
    if a.start_date is not None or a.end_date is not None:
        try:
            dates = []
            for raw in [a.start_date, a.end_date]:
                if raw is None or not re.fullmatch(r'[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}', raw):
                    raise ValueError()
                dates.append(date(*map(int, raw.split('-'))))
            if dates[0] > dates[1]:
                raise ValueError()
            period = dict(zip(['start_date', 'end_date'], (d.isoformat() for d in dates)))
        except ValueError as exc:
            raise Failure('ARGUMENT_ERROR', '请提供成对、有效且顺序正确的统计日期') from exc
    return {'all_shops': not shops, 'shops': shops, 'period': period}


def path_value(value, base):
    require(isinstance(value, str) and bool(value.strip()), '路径必须为非空字符串')
    def expand(match):
        name = match.group(1)
        require(name in os.environ, '未定义环境变量：' + name)
        return os.environ[name]
    value = re.sub(r'\$\{([^}]+)\}', expand, value)
    require(bool(value.strip()) and '${' not in value, '路径变量格式')
    path = Path(value).expanduser()
    return (path if path.is_absolute() else base / path).resolve()


def load_yaml(path):
    try:
        value = yaml.safe_load(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError, yaml.YAMLError) as exc:
        raise Failure('CONFIG_INVALID', '无法读取有效YAML配置：' + str(path)) from exc
    require(isinstance(value, dict), str(path) + '根节点必须为对象')
    require(type(value.get('config_version')) is int and value['config_version'] == 1, 'config_version')
    return value


def validate(c, t, d):
    """Check this fixed product contract, without evaluating business formulas."""
    require(c['skill_name'] == SKILL, 'skill_name')
    for name in ['data_root', 'upstream_state_root', 'runtime_root']:
        require(isinstance(c['paths'][name], str), 'paths.' + name)
    for name in ['parent_folder_path', 'base_name', 'table_name', 'dashboard_name']:
        require(isinstance(c['target'][name], str) and bool(c['target'][name].strip()), 'target.' + name)
    require(c['currency'] == {'shop': 'PHP', 'ads': 'USD', 'check_every_sync': True,
            'mismatch_action': 'block_shop', 'allow_empty_product_ads_without_ads': True,
            'rewrite_global_labels': False}, 'currency')
    for key in ['check_every_sync', 'allow_empty_product_ads_without_ads', 'rewrite_global_labels']:
        require(type(c['currency'][key]) is bool, 'currency.' + key)
    require(all(c['execution'][k] is True for k in ['single_machine', 'serial']), 'execution')
    require(t['record_types'] == TYPES, 'record_types')
    fields = t['fields']
    require(isinstance(fields, list) and len(fields) == 26, '26字段')
    by = {f['name']: f for f in fields}
    require(set(by) == set(COMMON + SUMMARY + PRODUCT), '字段名称或重复字段')
    require(fields[0]['name'] == '记录唯一键', '主字段位置')
    require([f['name'] for f in fields if f.get('primary')] == ['记录唯一键'], '主字段')
    for name, f in by.items():
        expected_type = ('single_select' if name == '记录类型' else 'date' if name in COMMON[4:6]
                         else 'datetime' if name == '数据更新时间' else 'number'
                         if name in SUMMARY + PRODUCT[2:] else 'text')
        require(f['type'] == expected_type, name + '.type')
        require(f['record_types'] == (TYPES if name in COMMON else [TYPES[0]] if name in SUMMARY else [TYPES[1]]), name + '.record_types')
        require(f['nullable'] is (name in SUMMARY + PRODUCT[1:] + COMMON[7:9]), name + '.nullable')
    require(by['记录唯一键'].get('primary') is True and by['记录类型']['options'] == TYPES, '主键和单选类型')
    sources = t['sources']
    require(set(sources) == {'shop', 'ads', 'product'}, 'sources')
    source_columns = {
        'shop': ['店铺GMV', '订单数', '客户数', 'AOV', '退款金额率', '店铺币种'],
        'ads': ['广告户ID', '广告总成本', 'GMV Max总收入', '实际ROI', 'GMV Max SKU订单数', 'GMV Max平均下单成本', '广告币种'],
        'product': ['商品ID', '商品名称', '商品GMV', '订单数', '实际ROI', '退款金额率', '店铺币种', '广告币种']}
    for source, filename in [('shop', '店铺诊断'), ('ads', '广告户诊断'), ('product', '商品经营诊断')]:
        s = sources[source]
        require(s['relative_path'] == '20_清洗数据/' + filename + '.xlsx' and s['sheet'] == '数据', 'sources.' + source)
        require(isinstance(s['required_headers'], list) and len(set(s['required_headers'])) == len(s['required_headers'])
                and set(s['required_headers']) == set(COMMON[2:6] + source_columns[source]), source + '.required_headers')
    mappings = [
        ('shop', '店铺GMV'), ('shop', '订单数'), ('shop', '客户数'),
        ('shop', 'AOV'), ('shop', '退款金额率'),
        ('ads', '广告总成本'), ('ads', 'GMV Max总收入'), ('ads', '实际ROI'),
        ('ads', 'GMV Max SKU订单数'), ('ads', 'GMV Max平均下单成本'),
        ('product', '商品GMV'), ('product', '订单数'), ('product', '实际ROI'),
        ('product', '退款金额率')]
    require(set(t['metrics']) == set(SUMMARY + PRODUCT[2:]), 'metrics')
    for name, mapping in zip(SUMMARY + PRODUCT[2:], mappings):
        keys = ['source', 'field']
        require(t['metrics'][name] == dict(zip(keys, mapping)), 'metrics.' + name)
        require(all(col in sources[mapping[0]]['required_headers'] for col in mapping[1:]), '指标源列引用')
    require(t['keys'] == {TYPES[0]: '店铺汇总|{shop_id}|{start_date}|{end_date}', TYPES[1]: '商品结果|{shop_id}|{start_date}|{end_date}|{product_id}'}, 'keys')
    require(t['period_labels'] == {'single_day': '{start_date}', 'range': '{start_date} ～ {end_date}'}, 'period_labels')
    rules = t['rules']
    for key in ['include_cancelled_orders', 'preserve_zero', 'required_headers_must_exist', 'rename_preserve_business_values',
                'shop_currency_required_when_amount_present', 'ads_currency_required_when_amount_present', 'product_ads_currency_nullable_without_ads']:
        require(rules[key] is True, 'rules.' + key)
    for key in ['generate_missing_periods', 'delete_absent_records']:
        require(rules[key] is False, 'rules.' + key)
    for key in ['non_applicable_value', 'source_null_value']:
        require(rules[key] is None, 'rules.' + key)
    for key, value in {'period_match': 'exact', 'customer_count': 'read_cleaned_period', 'missing_identity': 'block_scope',
                       'duplicate_key': 'block_scope', 'sync_actions': ['insert', 'update', 'skip'], 'rename_scope': 'all_rows_same_shop_id'}.items():
        require(rules[key] == value, 'rules.' + key)
    require(d['modules'] == ['整体经营', '广告表现', '商品表现'], 'modules')
    cards = d['cards']
    require(isinstance(cards, list) and len(cards) == 10 and {x['field'] for x in cards} == set(SUMMARY), 'cards')
    def check_format(item, name):
        unit = 'PHP' if name in ['GMV', 'AOV', '商品GMV'] else 'USD' if name in ['广告消耗', '广告收入', '平均下单成本'] else '%' if '退款金额率' in name else None
        integer = name in ['订单数', '客户数', '广告订单', '商品订单数']
        fmt = 'integer' if integer else 'percent' if unit == '%' else 'currency' if unit else 'number'
        require(item['unit'] == unit and item['format'] == fmt and type(item['precision']) is int
                and item['precision'] == (0 if integer else 2), name + '.format/unit/precision')
    def check_filter(item, value):
        require(item == {'field': '记录类型', 'operator': 'eq', 'value': value}, 'fixed_filter')
    for card in cards:
        name = card['field']
        check_format(card, name)
        check_filter(card['fixed_filter'], TYPES[0])
        require(card['aggregation'] == 'SUM' and card['module'] == d['modules'][0 if SUMMARY.index(name) < 5 else 1], 'card aggregation/module')
        require(isinstance(card['title'], str) and bool(card['title'].strip()), 'card.title')
        require(name != 'AOV' or 'SKU' in card['title'], 'AOV标题口径')
    pv = d['product_view']
    require(pv['component'] == 'view' and pv['columns'] == PRODUCT and pv['group_by'] is None
            and pv['sort'] == {'field': '商品GMV', 'direction': 'desc'} and pv['preserve_primary_field_if_required'] is True, 'product_view')
    check_filter(pv['fixed_filter'], TYPES[1])
    for name in PRODUCT[2:]:
        check_format(pv['formats'][name], name)
    require(len(d['slicers']) == 2, 'slicers')
    for item, name in zip(d['slicers'], ['店铺名称', '统计区间']):
        require(item['field'] == name and item['single_select'] is True and item['source'] == 'boss_table', 'slicer')
    defaults = d['defaults']
    require(defaults['shop_policy'] == 'explicit_else_agent_select_valid' and 'shop_value' not in defaults and 'period_value' not in defaults, 'default shop')
    require(defaults['period_order'] == [{'field': '统计结束日期', 'direction': 'desc'}, {'field': '统计开始日期', 'direction': 'asc'}], 'period_order')
    require(defaults['reset_on_sync'] is False and defaults['repair_default_shop_on_rename'] is True
            and defaults['preserve_default_period_on_rename'] is True, 'defaults sync/rename')
    require(d['browser'] == {'product_view': 'agent_browser', 'slicers': 'agent_browser'}, 'browser')
    for key, tokens in {'currency': ['PHP', 'USD'], 'aov': ['已清洗', 'SKU订单口径'], 'selection': ['清空'], 'empty': ['0']}.items():
        require(isinstance(d['notes'][key], str) and all(token in d['notes'][key] for token in tokens), 'notes.' + key)


def main():
    result = {'skill': SKILL, 'stage': '05' if any(x == '--recover-state' or x.startswith('--recover-state=') for x in sys.argv[1:]) else '03' if '--data-only' in sys.argv[1:] else '02' if '--build-only' in sys.argv[1:] else '01' if '--check-only' in sys.argv[1:] else '04', 'mode': None, 'status': 'ERROR', 'error_code': None,
              'message': '', 'completed': dict.fromkeys(['config_checked', 'scope_normalized', 'source_version_checked', 'data_built', 'feishu_written', 'dashboard_ready'], False)}
    exit_code = 0
    try:
        a = arguments()
        full = not (a.check_only or a.build_only or a.data_only)
        result['mode'] = a.mode
        result['scope'] = normalize(a)
        if not a.check_only:
            for name in result['scope']['shops']:
                if Path(name).is_absolute() or any(token in name for token in ['/', '\\', '..', ':']) or name == '.':
                    raise Failure('ARGUMENT_ERROR', '构建店名必须是直接子目录名，不能使用路径或跳转')
        result['completed']['scope_normalized'] = True
        config_path = path_value(a.config, Path.cwd())
        c = load_yaml(config_path)
        try:
            t = load_yaml(path_value(c['definitions']['table'], config_path.parent))
            d = load_yaml(path_value(c['definitions']['dashboard'], config_path.parent))
            validate(c, t, d)
            if a.data_only or full:
                from feishu_sync import settings
                try:
                    settings(c)
                except ValueError as exc:
                    raise Failure('CONFIG_INVALID', str(exc)) from exc
            paths = {name: path_value(getattr(a, name) if getattr(a, name) is not None else c['paths'][name], config_path.parent)
                     for name in ['data_root', 'upstream_state_root', 'runtime_root']}
        except (KeyError, TypeError, IndexError, AttributeError) as exc:
            raise Failure('CONFIG_INVALID', '配置缺少必要键或基本类型错误：' + str(exc)) from exc
        result['completed']['config_checked'] = True
        runtime = paths['runtime_root']
        if a.recover_state is None and any(not paths[n].is_dir() for n in ['data_root', 'upstream_state_root']):
            raise Failure('PATH_INVALID', '来源根目录与上游状态根目录必须已存在且为目录')
        if runtime.exists() and not runtime.is_dir():
            raise Failure('PATH_INVALID', '运行路径不是目录')
        for other in [ROOT, paths['data_root'], paths['upstream_state_root']]:
            if runtime.is_relative_to(other) or other.is_relative_to(runtime):
                raise Failure('PATH_INVALID', '运行目录与Skill、来源、上游目录不得相互包含')
        result['paths'] = {k: str(v) for k, v in paths.items()}
        result['config_summary'] = {'field_count': len(t['fields']), 'metric_count': len(t['metrics']),
            'card_count': len(d['cards']), 'product_column_count': len(d['product_view']['columns']),
            'slicer_fields': [s['field'] for s in d['slicers']]}
        with LocalRunLock(runtime):
            state = read_state(runtime)
            if a.recover_state is not None and (runtime / 'state' / 'state.json').exists():
                raise Failure('STATE_ALREADY_PRESENT', '有效state已存在；恢复不会覆盖原登记。', 'BLOCKED', 4)
            if full and a.mode == 'sync' and a.browser_result is not None and not state.get('default_repair'):
                raise Failure('ARGUMENT_ERROR', '普通sync没有默认修复待办，不能提交网页回执')
            if full and a.mode == 'sync' and a.recover_state is None:
                from dashboard_manager import page_initialized
                if not page_initialized(state):
                    raise Failure('TARGET_NOT_INITIALIZED', '完整sync需要已确认页面；请先完成init及网页待办。', 'BLOCKED', 4)
            run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '_' + uuid.uuid4().hex
            result.update(status='PREFLIGHT_OK', run_id=run_id, message='本地配置与范围预检完成；尚未读取业务数据或创建飞书看板。')
            log = runtime / 'logs' / (run_id + '.log')
            output = runtime / 'runs' / run_id / 'result.json'
            result['artifacts'] = {'result_json': str(output), 'log_file': str(log)}
            if a.recover_state is not None:
                import feishu_client
                from state_store import recover_state, RecoveryError
                c['_managed_fields'] = {f['name']: f['type'] for f in t['fields']}
                confirmation = path_value(a.recover_state, config_path.parent)
                try:
                    client = feishu_client.create_client(c, runtime)
                    recovered = recover_state(client,c,t,d,confirmation)
                    recovered.setdefault('last_recovery', {})['run_id'] = run_id
                    write_json(runtime / 'state' / 'state.json', recovered)
                    result.update(status='STATE_RECOVERED',error_code=None,
                                  message='已只读核对原目标并恢复本地资源登记；下一次普通sync才同步业务数据。',
                                  recovery_summary={'record_count':len(recovered['records']),
                                                    'field_count':len(recovered['resources']['field_ids'])})
                except RecoveryError as exc:
                    result.update(status='ERROR' if exc.exit_code == 6 else 'BLOCKED',error_code=exc.code,message=str(exc))
                    exit_code = exc.exit_code
                except feishu_client.FeishuError as exc:
                    result.update(status='ERROR',error_code='REMOTE_ERROR',message=str(exc))
                    exit_code = 6
            elif not a.check_only:
                # Lazy import preserves the original preflight read/dependency boundary.
                from boss_data_builder import build
                generated_at = datetime.now(timezone.utc).isoformat()
                built = build(paths, result['scope'], t, generated_at)
                ready, blocked = bool(built['records']), bool(built['issues'])
                status = ('PARTIAL_READY' if ready else 'BLOCKED') if blocked else ('DATA_READY' if ready else 'NO_DATA')
                exit_code = (5 if ready else 4) if blocked else 0
                result.update(status=status, error_code=('SOURCE_PARTIAL' if ready else 'SOURCE_BLOCKED') if blocked else None,
                              issues=built['issues'], build_summary=built['build_summary'],
                              message='离线构建结束；请按状态和issues使用有效候选，未写入飞书或创建看板。')
                result['completed'].update(source_version_checked=built['source_version_checked'], data_built=ready)
                candidate_path = output.with_name('candidates.json')
                result['artifacts']['candidates_json'] = str(candidate_path)
                write_json(candidate_path, {'schema_version': 1, 'skill': SKILL, 'run_id': run_id, 'generated_at': generated_at,
                           'status': status, 'records': built['records'], 'source_files': built['source_files'], 'issues': built['issues']})
                if (a.data_only or full) and ready:
                    import feishu_client
                    from feishu_sync import synchronize
                    c['_managed_fields'] = {f['name']: f['type'] for f in t['fields']}
                    try:
                        client = feishu_client.create_client(c, runtime)
                        synced = synchronize(client, c, t, state, built['records'], run_id,
                                             {'mode': a.mode, 'scope': result['scope']},
                                             lambda: write_json(runtime / 'state' / 'state.json', state), built['issues'])
                    except feishu_client.FeishuError as exc:
                        synced = {'status': 'ERROR', 'error_code': 'REMOTE_ERROR', 'exit_code': 6,
                                  'sync_summary': {'candidate_count': len(built['records']), 'inserted': 0, 'updated': 0, 'skipped': 0, 'confirmed_count': 0},
                                  'actions': [], 'issues': built['issues'] + [{'code': exc.code, 'message': str(exc), 'shop_directory': None, 'source': None, 'period': None}]}
                    result.update(status=synced['status'], error_code=synced['error_code'], sync_summary=synced['sync_summary'], issues=synced['issues'],
                                  message='老板看板底表处理结束；请按状态与issues确认结果，仪表盘页面尚未创建。')
                    result['maintenance_summary'] = synced.get('maintenance_summary', {
                        'renamed_record_count':0,'history_name_update_count':0,'default_repair_required':bool(state.get('default_repair'))})
                    exit_code = synced['exit_code']
                    result['completed']['feishu_written'] = synced['status'] in ['DATA_SYNCED', 'PARTIAL_SYNCED']
                    report_path = output.with_name('sync_report.json')
                    result['artifacts']['sync_report_json'] = str(report_path)
                    write_json(report_path, {'run_id': run_id, 'status': synced['status'], 'sync_summary': synced['sync_summary'],
                               'maintenance_summary':result['maintenance_summary'],'history_name_actions':synced.get('history_name_actions',[]),
                               'actions': synced['actions'], 'issues': synced['issues']})
                    if full and result['completed']['feishu_written']:
                        from dashboard_manager import manage
                        confirmed_keys = {x['key'] for x in synced['actions'] if x.get('confirmation') == 'confirmed'}
                        confirmed = [x for x in built['records'] if x['记录唯一键'] in confirmed_keys]
                        receipt = None
                        if a.browser_result is not None:
                            receipt = Path(a.browser_result).expanduser()
                            receipt = (receipt if receipt.is_absolute() else config_path.parent / receipt).resolve()
                        page = manage(client, c, d, state, confirmed, a.mode, a.default_shop, receipt,
                                      output.parent, run_id, result['scope'], synced['issues'],
                                      lambda: write_json(runtime / 'state' / 'state.json', state))
                        result.update({k: v for k, v in page.items() if k not in ['exit_code', 'artifacts']})
                        result['artifacts'].update(page['artifacts'])
                        result['completed']['dashboard_ready'] = page['status'] in ['PAGE_READY', 'PAGE_PARTIAL']
                        result['maintenance_summary']['default_repair_required'] = bool(state.get('default_repair'))
                        exit_code = page['exit_code']
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(json.dumps({'mode': a.mode, 'scope': result['scope'], 'status': result['status']}, ensure_ascii=False) + '\n', encoding='utf-8')
            write_json(output, result)
            if a.check_only:
                state['last_preflight'] = {'run_id': run_id, 'mode': a.mode, 'scope': result['scope'], 'checked_at': datetime.now(timezone.utc).isoformat()}
            elif a.build_only and result['status'] != 'BLOCKED':
                state['last_build'] = {'run_id': run_id, 'status': result['status'], 'record_count': len(built['records']),
                                       'candidates_json': str(candidate_path), 'generated_at': generated_at}
            if a.check_only or a.build_only and result['status'] != 'BLOCKED':
                write_json(runtime / 'state' / 'state.json', state)
    except (RunLocked, StateInvalid) as exc:
        result.update(status='BLOCKED', error_code='RUN_LOCKED' if isinstance(exc, RunLocked) else 'STATE_INVALID', message=str(exc))
        exit_code = 4
    except Failure as exc:
        result.update(status=exc.status, error_code=exc.code, message=str(exc))
        exit_code = exc.exit_code
    except OSError as exc:
        result.update(status='ERROR', error_code='IO_ERROR', message=str(exc))
        exit_code = 2
    print(json.dumps(result, ensure_ascii=False))
    return exit_code


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    raise SystemExit(main())
