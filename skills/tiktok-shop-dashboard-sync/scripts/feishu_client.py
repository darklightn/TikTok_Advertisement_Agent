"""Official lark-cli user adapter. No login, identity switch or test transport."""
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import subprocess
import uuid

TZ = timezone(timedelta(hours=8))


class FeishuError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def need(condition, message):
    if not condition:
        raise FeishuError('REMOTE_INVALID_RESPONSE', message)


def field_payload(spec):
    kind = spec['type']
    obj = {'name': spec['name'], 'type': 'select' if kind == 'single_select' else 'datetime' if kind in ['date', 'datetime'] else kind}
    if kind == 'single_select':
        obj.update(multiple=False, options=[{'name': name} for name in spec['options']])
    if kind in ['date', 'datetime']:
        obj['style'] = {'format': 'yyyy-MM-dd' if kind == 'date' else 'yyyy-MM-dd HH:mm Z'}
    return obj


class CliClient:
    def __init__(self, config, runtime_root):
        from feishu_sync import settings
        self.feishu, self.tuning = settings(config)
        self.config = config
        self.root = Path(runtime_root) / 'cli_evidence' / uuid.uuid4().hex
        self.root.mkdir(parents=True)
        self.sequence = 0
        self.schemas = {}

    def call(self, args, payload_flag=None, payload=None, output=False):
        self.sequence += 1
        where = self.root / f'{self.sequence:04d}'
        where.mkdir()
        argv = [*self.feishu['cli_command'], *args]
        if payload_flag:
            (where / 'request.json').write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding='utf-8')
            argv += [payload_flag, '@request.json']
        if output:
            argv += ['--format', 'ndjson', '--output', 'records.ndjson']
        argv += ['--as', 'user']
        (where / 'command.json').write_text(json.dumps({'argv': argv, 'cwd': str(where)}, ensure_ascii=False, indent=2), encoding='utf-8')
        env = dict(os.environ, LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1')
        try:
            response = subprocess.run(argv, cwd=where, capture_output=True, text=True, encoding='utf-8',
                                      timeout=self.feishu['timeout_seconds'], env=env, shell=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            (where / 'failure.txt').write_text(type(exc).__name__ + ': request outcome unconfirmed', encoding='utf-8')
            raise FeishuError('REMOTE_IO_ERROR', 'CLI无法执行或请求超时；写入结果不确定，不自动重试') from exc
        (where / 'stdout.json').write_text(response.stdout, encoding='utf-8')
        (where / 'stderr.txt').write_text(response.stderr, encoding='utf-8')
        (where / 'exit_code.txt').write_text(str(response.returncode), encoding='utf-8')
        if response.returncode:
            try:
                error = json.loads(response.stderr).get('error', {})
            except ValueError:
                error = {}
            code = str(error.get('code', ''))
            label = str(error.get('message', '')).lower()
            notfound = code in ['1254040', '1254041', '1254043', '1061003'] or 'not found' in label or 'not exist' in label
            kind = 'REMOTE_NOT_FOUND' if notfound else 'REMOTE_PERMISSION_DENIED' if error.get('type') == 'authorization' or 'permission' in label else 'REMOTE_IO_ERROR'
            raise FeishuError(kind, '官方CLI调用失败；退出码' + str(response.returncode) + '，见本轮原始调用证据')
        try:
            obj = json.loads(response.stdout)
        except ValueError as exc:
            raise FeishuError('REMOTE_INVALID_RESPONSE', 'CLI未返回单个JSON对象') from exc
        need(isinstance(obj, dict), 'CLI响应不是对象')
        if output:
            need(obj.get('format') == 'ndjson' and type(obj.get('has_more')) is bool, 'NDJSON manifest无效')
            path = where / 'records.ndjson'
            need(path.is_file(), 'CLI未生成记录文件')
            try:
                rows = [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line.strip()]
            except ValueError as exc:
                raise FeishuError('REMOTE_INVALID_RESPONSE', 'NDJSON内容无效') from exc
            need(len(rows) == obj.get('records_count'), 'NDJSON与manifest行数不同')
            return obj, rows
        need(obj.get('ok') is True and isinstance(obj.get('data'), dict), '官方成功信封无效')
        return obj['data']

    def drive_children(self, token):
        items, seen, cursor = [], set(), None
        while True:
            args = ['drive', 'files', 'list', '--folder-token', token, '--page-size', '200']
            if cursor:
                args += ['--page-token', cursor]
            obj = self.call(args)
            need(isinstance(obj.get('files'), list) and type(obj.get('has_more')) is bool, '目录响应不完整')
            items.extend(obj['files'])
            if not obj['has_more']:
                return items
            cursor = obj.get('next_page_token') or obj.get('page_token')
            need(isinstance(cursor, str) and cursor and cursor not in seen, '目录分页不完整')
            seen.add(cursor)

    def resolve_parent(self, folder_path, configured_token=None):
        if configured_token:
            return {'folder_token': configured_token, 'path': folder_path}
        need(isinstance(folder_path, str) and folder_path.startswith('/'), '父目录路径须为绝对云盘路径')
        root = self.call(['api', 'GET', '/open-apis/drive/explorer/v2/root_folder/meta'])
        token = root.get('token')
        need(isinstance(token, str) and token, '云盘根目录ID无效')
        for name in [x for x in folder_path.split('/') if x]:
            matches = [x for x in self.drive_children(token) if x.get('type') == 'folder' and x.get('name') == name]
            if len(matches) != 1:
                raise FeishuError('REMOTE_PARENT_UNCONFIRMED', '父目录缺失或同名歧义，请Agent确认；未回退根目录')
            token = matches[0]['token']
        return {'folder_token': token, 'path': folder_path}

    def find_bases(self, folder_token, name):
        return [{'base_token': x['token'], 'name': x['name'], 'folder_token': folder_token}
                for x in self.drive_children(folder_token) if x.get('type') == 'bitable' and x.get('name') == name]

    def get_base(self, base_token):
        obj = self.call(['base', '+base-get', '--base-token', base_token])
        base = obj.get('base', obj.get('app', obj))
        need(isinstance(base, dict) and isinstance(base.get('name'), str), 'Base信息无效')
        return {'base_token': base_token, 'name': base['name'], 'folder_token': base.get('folder_token'), 'url': base.get('url')}

    def create_base(self, folder_token, name, table_name, fields):
        obj = self.call(['base', '+base-create', '--folder-token', folder_token, '--name', name,
                         '--table-name', table_name, '--time-zone', 'Asia/Shanghai'], '--fields', [field_payload(x) for x in fields])
        base = obj.get('base', obj.get('app', obj))
        token = base.get('token') or base.get('base_token') or base.get('app_token')
        table = obj.get('table', {})
        tid = obj.get('table_id') or table.get('id') or table.get('table_id')
        need(isinstance(token, str) and token, '创建Base返回缺少ID；请确认本轮结果后登记')
        return {'base_token': token, 'table_id': tid}

    def list_tables(self, base_token):
        items, offset = [], 0
        while True:
            obj = self.call(['base', '+table-list', '--base-token', base_token, '--offset', str(offset), '--limit', '100'])
            rows = obj.get('tables', obj.get('items'))
            need(isinstance(rows, list), '表列表响应无效')
            items.extend({'table_id': r.get('id', r.get('table_id')), 'name': r['name']} for r in rows)
            more = obj.get('has_more', len(rows) == 100)
            if not more:
                return items
            need(bool(rows), '表分页无进展')
            offset += len(rows)

    def create_table(self, base_token, name, fields):
        obj = self.call(['base', '+table-create', '--base-token', base_token, '--name', name], '--fields', [field_payload(x) for x in fields])
        table = obj.get('table', obj)
        return {'table_id': table.get('id', table.get('table_id'))}

    def list_fields(self, base_token, table_id):
        obj = self.call(['base', '+table-get', '--base-token', base_token, '--table-id', table_id])
        need(isinstance(obj.get('fields'), list) and isinstance(obj.get('table'), dict), '表详情缺少字段或主字段信息')
        primary = obj['table'].get('primary_field')
        need(isinstance(primary, str) and primary, '无法确认主字段')
        result = []
        for f in obj['fields']:
            kind = f['type']
            if kind == 'select' and f.get('multiple', False) is False:
                kind = 'single_select'
            elif kind == 'datetime':
                fmt = f.get('style', {}).get('format', 'yyyy/MM/dd')
                kind = 'datetime' if 'HH' in fmt else 'date'
            item = {'field_id': f['id'], 'name': f['name'], 'type': kind, 'primary': f['id'] == primary}
            if kind == 'single_select':
                item['options'] = [x['name'] for x in f.get('options', [])]
            result.append(item)
        self.schemas[(base_token, table_id)] = result
        return result

    def create_field(self, base_token, table_id, field):
        self.call(['base', '+field-create', '--base-token', base_token, '--table-id', table_id], '--json', field_payload(field))
        for _ in range(self.tuning['readback_attempts']):
            fields = self.list_fields(base_token, table_id)
            matches = [f for f in fields if f['name'] == field['name']]
            if len(matches) == 1:
                return matches[0]
            import time
            time.sleep(self.tuning['readback_interval_seconds'])
        raise FeishuError('REMOTE_INVALID_RESPONSE', '新字段回读未确认；不自动重复创建')

    @staticmethod
    def normalize(value, spec):
        if value is None or value == '' or value == []:
            return None
        kind = spec['type']
        if kind == 'single_select':
            need(isinstance(value, list) and len(value) == 1 and isinstance(value[0], str), '单选值格式未知')
            return value[0]
        if kind in ['date', 'datetime']:
            try:
                d = datetime.fromtimestamp(value / 1000, tz=TZ) if type(value) in (int, float) else datetime.fromisoformat(value.replace('Z', '+00:00'))
                if d.tzinfo is None:
                    d = d.replace(tzinfo=TZ)
                return d.astimezone(TZ).date().isoformat() if kind == 'date' else d.isoformat()
            except (ValueError, TypeError, AttributeError, OverflowError) as exc:
                raise FeishuError('REMOTE_INVALID_RESPONSE', '日期值格式未知') from exc
        if kind == 'text':
            need(isinstance(value, str), '文本值格式未知')
        if kind == 'number':
            need(type(value) in (int, float) and math.isfinite(value), '数值格式未知')
        return value

    def list_records(self, base_token, table_id, page_token=None, page_size=100):
        fields = self.schemas.get((base_token, table_id)) or self.list_fields(base_token, table_id)
        managed = [f for f in fields if f['name'] in self.config['_managed_fields']]
        offset = int(page_token or 0)
        args = ['base', '+record-list', '--base-token', base_token, '--table-id', table_id, '--offset', str(offset), '--limit', str(page_size)]
        for f in managed:
            args += ['--field-id', f['name']]
        manifest, rows = self.call(args, output=True)
        need(manifest.get('base_token') == base_token and manifest.get('table_id') == table_id, '记录导出目标不匹配')
        need(not manifest['has_more'] or bool(rows), '记录分页无进展')
        return {'items': [{'record_id': row['record_id'], 'fields': {f['name']: self.normalize(row.get(f['name']), f) for f in managed}} for row in rows],
                'has_more': manifest['has_more'], 'page_token': str(offset + len(rows)) if manifest['has_more'] else None}

    def encode(self, row):
        result = dict(row)
        for name, kind in self.config['_managed_fields'].items():
            if row.get(name) is not None:
                if kind == 'single_select':
                    result[name] = [row[name]]
                elif kind == 'date':
                    result[name] = row[name] + 'T00:00:00+08:00'
        return result

    def batch_create(self, base_token, table_id, records):
        obj = self.call(['base', '+record-batch-create', '--base-token', base_token, '--table-id', table_id], '--json', {'create_records': [self.encode(r) for r in records]})
        return {'record_ids': obj.get('record_id_list'), 'ignored_fields': obj.get('ignored_fields', [])}

    def batch_update(self, base_token, table_id, records):
        obj = self.call(['base', '+record-batch-update', '--base-token', base_token, '--table-id', table_id], '--json', {'update_records': {rid: self.encode(r) for rid, r in records.items()}})
        return {'ignored_fields': obj.get('ignored_fields', [])}

    def page_list(self, command, args):
        items, seen, cursor = [], set(), None
        while True:
            argv = ['base', command, *args, '--page-size', '100']
            if cursor:
                argv += ['--page-token', cursor]
            data = self.call(argv)
            need(isinstance(data.get('items'), list), '页面列表缺少items')
            items.extend(data['items'])
            need(type(data.get('has_more', False)) is bool, '页面分页标记无效')
            if not data.get('has_more', False):
                return items
            cursor = data.get('page_token')
            need(isinstance(cursor, str) and cursor and cursor not in seen, '页面分页不完整')
            seen.add(cursor)

    @staticmethod
    def page_object(data, name, id_key):
        obj = data.get(name, data)
        need(isinstance(obj, dict), name + '响应不是对象')
        identity = obj.get(id_key) or obj.get('id')
        need(isinstance(identity, str) and identity, name + '响应没有实际ID')
        return dict(obj, **{id_key: identity})

    def list_dashboards(self, base_token):
        return [self.page_object(x, 'dashboard', 'dashboard_id')
                for x in self.page_list('+dashboard-list', ['--base-token', base_token])]

    def get_dashboard(self, base_token, dashboard_id):
        data = self.call(['base', '+dashboard-get', '--base-token', base_token, '--dashboard-id', dashboard_id])
        return self.page_object(data, 'dashboard', 'dashboard_id')

    def create_dashboard(self, base_token, name):
        data = self.call(['base', '+dashboard-create', '--base-token', base_token, '--name', name])
        return self.page_object(data, 'dashboard', 'dashboard_id')

    def list_dashboard_blocks(self, base_token, dashboard_id):
        items = self.page_list('+dashboard-block-list', ['--base-token', base_token, '--dashboard-id', dashboard_id])
        result = []
        for item in items:
            obj = self.page_object(item, 'block', 'block_id')
            if not isinstance(obj.get('data_config'), dict):
                obj = self.get_dashboard_block(base_token, dashboard_id, obj['block_id'])
            result.append(obj)
        return result

    def get_dashboard_block(self, base_token, dashboard_id, block_id):
        data = self.call(['base', '+dashboard-block-get', '--base-token', base_token, '--dashboard-id', dashboard_id, '--block-id', block_id])
        obj = self.page_object(data, 'block', 'block_id')
        need(isinstance(obj.get('data_config'), dict) and isinstance(obj.get('type'), str), '组件配置返回不完整')
        return obj

    def create_dashboard_block(self, base_token, dashboard_id, name, block_type, data_config):
        need(block_type in ['statistics', 'text'], '商品view与切片器通过Agent正常网页创建')
        data = self.call(['base', '+dashboard-block-create', '--base-token', base_token, '--dashboard-id', dashboard_id,
                          '--name', name, '--type', block_type], '--data-config', data_config)
        return self.page_object(data, 'block', 'block_id')

    def update_dashboard_block(self, base_token, dashboard_id, block_id, name, data_config):
        data = self.call(['base', '+dashboard-block-update', '--base-token', base_token, '--dashboard-id', dashboard_id,
                          '--block-id', block_id, '--name', name], '--data-config', data_config)
        # This endpoint may acknowledge an update without a block body; the manager reads it back.
        return data

    def get_product_view(self, base_token, table_id, view_id):
        common = ['--base-token', base_token, '--table-id', table_id]
        data = self.call(['base', '+table-get', *common])
        need(isinstance(data.get('table'), dict) and isinstance(data.get('fields'), list), '商品视图所属表详情无效')
        views = data['table'].get('views', data.get('views'))
        need(isinstance(views, list), '未返回表视图列表')
        if not any(v.get('id', v.get('view_id')) == view_id for v in views):
            raise FeishuError('REMOTE_NOT_FOUND', '商品视图不在目标表中')
        names = {f['id']: f['name'] for f in data['fields']}
        payload = {}
        for kind in ['filter', 'sort', 'group', 'visible-fields']:
            payload[kind] = self.call(['base', '+view-get-' + kind, *common, '--view-id', view_id])
        filt = payload['filter'].get('filter')
        sort = payload['sort'].get('sort')
        group = payload['group'].get('group')
        cols = payload['visible-fields'].get('visible_fields')
        need(isinstance(filt, dict) and isinstance(sort, list) and isinstance(group, list) and isinstance(cols, list), '商品视图配置响应不完整')
        fixed = None
        conditions = filt.get('conditions', [])
        if filt.get('logic') == 'and' and len(conditions) == 1:
            c = conditions[0]
            if isinstance(c, list) and len(c) == 3 and names.get(c[0], c[0]) == '记录类型' and c[1:] == ['intersects', ['商品结果']]:
                fixed = {'field': '记录类型', 'operator': 'eq', 'value': '商品结果'}
        sorting = None
        if len(sort) == 1 and type(sort[0].get('desc')) is bool:
            sorting = {'field': names.get(sort[0]['field'], sort[0]['field']), 'direction': 'desc' if sort[0]['desc'] else 'asc'}
        return {'view_id': view_id, 'table_id': table_id, 'columns': [names.get(f, f) for f in cols],
                'sort': sorting, 'group_by': group or None, 'fixed_filter': fixed}

    def configure_product_view(self, base_token, table_id, view_id, spec):
        actual = self.get_product_view(base_token, table_id, view_id)
        common = ['--base-token', base_token, '--table-id', table_id, '--view-id', view_id]
        updates = []
        if actual['fixed_filter'] != spec['fixed_filter']:
            updates.append(('filter', {'logic': 'and', 'conditions': [[spec['fixed_filter']['field'], 'intersects', [spec['fixed_filter']['value']]]]}))
        if actual['sort'] != spec['sort']:
            updates.append(('sort', {'sort_config': [{'field': spec['sort']['field'], 'desc': spec['sort']['direction'] == 'desc'}]}))
        if actual['group_by']:
            updates.append(('group', {'group_config': []}))
        cols = list(spec['columns'])
        if spec.get('preserve_primary_field_if_required'):
            cols.insert(0, '记录唯一键')
        if actual['columns'] != cols:
            updates.append(('visible-fields', {'visible_fields': cols}))
        for kind, payload in updates:
            self.call(['base', '+view-set-' + kind, *common], '--json', payload)
        return {}


def create_client(config, runtime_root):
    return CliClient(config, runtime_root)
