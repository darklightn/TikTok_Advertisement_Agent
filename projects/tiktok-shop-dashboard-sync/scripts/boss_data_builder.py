"""Build offline candidates from verified sources using the frozen metric configuration."""
from collections import defaultdict
from decimal import Decimal, InvalidOperation
import math

from source_loader import discover, load_shop, issue, empty

COUNTS = {'订单数', '客户数', 'SKU订单数', 'GMV Max SKU订单数'}


def period_of(row):
    return (row['统计开始日期'], row['统计结束日期'])


def period_dict(period):
    return dict(zip(['start_date', 'end_date'], period))


def number(value, column):
    if empty(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ValueError(column + '不是有效数字')
    try:
        parsed = Decimal(str(value).strip())
    except InvalidOperation as exc:
        raise ValueError(column + '无法解析数字') from exc
    if not parsed.is_finite():
        raise ValueError(column + '不是有限值')
    if column in COUNTS:
        if parsed != parsed.to_integral_value():
            raise ValueError(column + '必须是整数值')
        return int(parsed)
    converted = float(parsed)
    if not math.isfinite(converted):
        raise ValueError(column + '超出可输出数字范围')
    return converted


def check_values(row, source, metrics, shop):
    problems = []
    columns = set()
    for mapping in metrics.values():
        if mapping['source'] == source:
            columns.add(mapping['field'])
    for col in columns:
        try:
            row[col] = number(row[col], col)
        except ValueError as exc:
            problems.append(issue('SOURCE_VALUE_INVALID', shop, source, period_dict(period_of(row)),
                                  f"第{row['_line']}行：{exc}"))
    return problems


def check_currency(row, source, shop):
    rules = []
    if source == 'shop':
        rules.append(('店铺币种', 'PHP', ['店铺GMV', 'AOV']))
    elif source == 'ads':
        rules.append(('广告币种', 'USD', ['广告总成本', 'GMV Max总收入', 'GMV Max平均下单成本']))
    elif source == 'product':
        rules.extend([('店铺币种', 'PHP', ['商品GMV']), ('广告币种', 'USD', [])])
    problems = []
    for field, expected, amounts in rules:
        raw = row[field]
        value = None if empty(raw) else raw.strip() if isinstance(raw, str) else raw
        row[field] = value
        code = 'CURRENCY_MISSING' if value is None and any(not empty(row[x]) for x in amounts) else 'CURRENCY_MISMATCH' if value is not None and value != expected else None
        if code:
            problems.append(issue(code, shop, source, period_dict(period_of(row)),
                                  f"第{row['_line']}行{field}应为{expected}，有金额时不能为空"))
    return problems


def record(config, kind, sources, generated_at):
    row = sources['shop'] if kind == '店铺汇总' else sources['product']
    start, end = period_of(row)
    values = {'shop_id': row['店铺ID'], 'start_date': start, 'end_date': end,
              'product_id': row.get('商品ID')}
    output = {f['name']: None for f in config['fields']}
    output.update({'记录唯一键': config['keys'][kind].format(**values), '记录类型': kind,
                   '店铺ID': row['店铺ID'], '店铺名称': row['店铺名称'], '统计开始日期': start,
                   '统计结束日期': end, '数据更新时间': generated_at,
                   '统计区间': config['period_labels']['single_day' if start == end else 'range'].format(**values),
                   '店铺币种': row['店铺币种'],
                   '广告币种': sources['ads']['广告币种'] if kind == '店铺汇总' else row['广告币种']})
    if kind == '商品结果':
        output['商品ID'] = row['商品ID']
        output['商品名称'] = None if empty(row['商品名称']) else str(row['商品名称']).strip()
    applicable = {f['name'] for f in config['fields'] if kind in f['record_types']}
    for target, mapping in config['metrics'].items():
        if target not in applicable:
            continue
        origin = sources[mapping['source']]
        value = origin[mapping['field']]
        if value is not None and not math.isfinite(value):
            raise ValueError('指标值超出有限数字范围：' + target)
        output[target] = value
    return output


def build(paths, scope, config, generated_at):
    names = discover(paths['data_root'], scope)
    shops = [load_shop(paths['data_root'], paths['upstream_state_root'], name, config['sources']) for name in names]
    files = [f for shop in shops for f in shop['source_files']]
    version_checked = bool(names) and len(files) == len(names) * len(config['sources'])
    identities, display_names = defaultdict(set), defaultdict(set)
    for shop in shops:
        rows = [r for group in shop['rows'].values() for r in group]
        ids = {r['店铺ID'] for r in rows}
        labels = {r['店铺名称'] for r in rows}
        if len(ids) > 1:
            shop['issues'].append(issue('SOURCE_IDENTITY_INVALID', shop['shop'], message='同目录来源店铺ID不一致'))
        if len(labels) > 1:
            shop['issues'].append(issue('SOURCE_NAME_CONFLICT', shop['shop'], message='同目录来源店铺名称不明确'))
        for identity in ids:
            identities[identity].add(shop['shop'])
        for label in labels:
            display_names[label].add(shop['shop'])
    for groups, code in [(identities, 'SOURCE_IDENTITY_INVALID'), (display_names, 'SOURCE_NAME_CONFLICT')]:
        for directories in groups.values():
            if len(directories) > 1:
                for shop in shops:
                    if shop['shop'] in directories:
                        shop['issues'].append(issue(code, shop['shop'], message='所选目录存在重复店铺ID或展示名称，需确认'))
    records, issues = [], []
    selected = None if scope['period'] is None else (scope['period']['start_date'], scope['period']['end_date'])
    for shop in shops:
        problems = [p for p in shop['issues'] if p['period'] is None or selected is None
                    or (p['period']['start_date'], p['period']['end_date']) == selected]
        if any(p['period'] is None for p in problems):
            issues.extend(problems)
            continue
        groups = {source: defaultdict(list) for source in config['sources']}
        for source, rows in shop['rows'].items():
            for row in rows:
                period = period_of(row)
                if selected is not None and period != selected:
                    continue
                groups[source][period].append(row)
                problems.extend(check_values(row, source, config['metrics'], shop['shop']))
                problems.extend(check_currency(row, source, shop['shop']))
        if any(p['code'] in ['CURRENCY_MISMATCH', 'CURRENCY_MISSING'] for p in problems):
            issues.extend(problems)
            continue
        periods = sorted(set().union(*(set(group) for group in groups.values())))
        for period in periods:
            scope_period = period_dict(period)
            current = {source: group[period] for source, group in groups.items()}
            if any(not rows for rows in current.values()):
                problems.append(issue('PERIOD_INCOMPLETE', shop['shop'], period=scope_period, message='完整区间缺少必要来源记录'))
            for source, rows in current.items():
                keys = [r['商品ID'] if source == 'product' else r['广告户ID'] if source == 'ads' else r['店铺ID'] for r in rows]
                if len(keys) != len(set(keys)):
                    problems.append(issue('SOURCE_DUPLICATE_KEY', shop['shop'], source, scope_period, '同来源同区间身份键重复'))
                elif source == 'ads' and len(keys) > 1:
                    problems.append(issue('MULTI_ADVERTISER_UNCONFIRMED', shop['shop'], source, scope_period, '多个广告户未经确认不能相加'))
            if any(p['period'] == scope_period for p in problems):
                continue
            try:
                source_rows = {'shop': current['shop'][0], 'ads': current['ads'][0]}
                complete = [record(config, '店铺汇总', source_rows, generated_at)]
                for product in current['product']:
                    complete.append(record(config, '商品结果', {'product': product}, generated_at))
                records.extend(complete)
            except (ValueError, OverflowError) as exc:
                problems.append(issue('SOURCE_VALUE_INVALID', shop['shop'], period=scope_period, message=str(exc)))
        issues.extend(problems)
    summary_count = sum(r['记录类型'] == '店铺汇总' for r in records)
    return {'records': records, 'issues': issues, 'source_files': files, 'source_version_checked': version_checked,
            'build_summary': {'shop_count': len(names), 'ready_period_count': summary_count, 'record_count': len(records),
                              'summary_record_count': summary_count, 'product_record_count': len(records) - summary_count}}
