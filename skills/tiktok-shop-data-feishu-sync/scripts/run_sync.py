"""Serial typed-file synchronization with last-success state commits."""
import argparse
from copy import deepcopy
from decimal import Decimal
from datetime import date
import json
import os
from pathlib import Path
import re
import stat

from bitable_client import BitableClient
import source_scanner
from source_reader import read_source
from state_store import StateStore
from sync_planner import plan_sync, required_volumes, build_target_table_name
from table_writer import write_table


class RunSyncError(Exception):
    def __init__(self, code, detail, context=None):
        self.code, self.detail = code, detail
        self.context = context or {}
        super().__init__(f'{code}: {detail}')


def _require(condition, code, detail):
    if not condition:
        raise RunSyncError(code, detail)


def _scope_date(value, code='SCOPE_DATE_INVALID'):
    try:
        if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}', value):
            raise ValueError('Expected YYYY-M-D')
        return date(*map(int, value.split('-'))).isoformat()
    except ValueError as exc:
        raise RunSyncError(code, 'Invalid calendar date', {'value': value}) from exc


def parse_file_period(relative_path):
    """Read only a complete trailing filename period, never record dates."""
    stem = relative_path.replace('\\', '/').rsplit('/', 1)[-1].rsplit('.', 1)[0]
    pattern = r'[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}'
    match = re.search(r'(?<![0-9])(' + pattern + r')_至_(' + pattern + r')$', stem)
    if match is None:
        match = re.search(r'(?<![0-9])(' + pattern + r')$', stem)
    if match is None:
        return None
    try:
        start = _scope_date(match[1], 'SOURCE_DATE_INVALID')
        end = _scope_date(match[2], 'SOURCE_DATE_INVALID') if match.lastindex == 2 else start
        if start > end:
            raise RunSyncError('SOURCE_DATE_INVALID', 'Reversed source period')
        return dict(start=start, end=end)
    except RunSyncError as exc:
        exc.context['relative_path'] = relative_path
        raise


def _scope_values(values, dimension):
    if values is None:
        return []
    if not isinstance(values, (list, tuple)) or any(not isinstance(v, str) or not v for v in values):
        raise RunSyncError('SCOPE_INVALID', 'Expected a list of nonempty names', {'dimension': dimension})
    return list(values)


def _scope_path(value, max_parts):
    normalized = value.replace('\\', '/')
    parts = normalized.split('/')
    if (len(parts) > max_parts or any(p in ('', '.', '..') for p in parts)
            or any(c in normalized for c in ':\x00*?')):
        raise RunSyncError('SCOPE_INVALID', 'Invalid relative path', {'value': value})
    return normalized


def _scope_catalogue(root, shop, extensions):
    """Enumerate directory metadata without opening or hashing source contents."""
    home = Path(root) / shop
    folders, files = set(), []
    def visit(directory, depth):
        for path in sorted(directory.iterdir(), key=lambda p: p.name):
            if path.name in {'Thumbs.db', 'desktop.ini', '.DS_Store'} or (
                    path.name.startswith('~$') and path.suffix.lower() == '.xlsx'):
                continue
            mode = path.stat().st_mode
            relative = path.relative_to(home).as_posix()
            if stat.S_ISDIR(mode) and depth < 2:
                folders.add(relative)
                visit(path, depth + 1)
            elif stat.S_ISREG(mode) and path.suffix.lower() in extensions:
                files.append(relative)
    try:
        visit(home, 0)
    except (OSError, ValueError) as exc:
        raise RunSyncError('SCOPE_DISCOVERY_FAILED', str(exc), {'shop': shop, 'path': str(home)}) from exc
    return folders, sorted(files)


def resolve_scope(config, *, shops=None, all_shops=False, folders=None, reports=None,
                  dates=None, date_ranges=None, files=None):
    """Resolve unions within dimensions and intersections across dimensions locally."""
    shop_values = _scope_values(shops, 'shops')
    _require(type(all_shops) is bool and all_shops != bool(shop_values),
             'SCOPE_INVALID', 'Select --all or one or more --shop')
    for shop in shop_values:
        _scope_path(shop, 1)
        _require('\\' not in shop and '/' not in shop, 'SCOPE_INVALID', 'Expected a shop directory name')
    folder_values = [_scope_path(v, 2) for v in _scope_values(folders, 'folders')]
    report_values = [_scope_path(v, 3) for v in _scope_values(reports, 'reports')]
    file_values = [_scope_path(v, 3) for v in _scope_values(files, 'files')]
    day_values = sorted({_scope_date(v) for v in _scope_values(dates, 'dates')})
    _require(date_ranges is None or isinstance(date_ranges, (list, tuple)), 'SCOPE_DATE_INVALID', 'Expected date ranges')
    ranges = set()
    for pair in date_ranges or []:
        _require(isinstance(pair, (list, tuple)) and len(pair) == 2, 'SCOPE_DATE_INVALID', 'Expected two range endpoints')
        start, end = (_scope_date(v) for v in pair)
        _require(start <= end, 'SCOPE_DATE_INVALID', 'Reversed date range')
        ranges.add((start, end))
    source = config['source']
    extensions = set(source['supported_extensions'])
    for value in file_values:
        _require(Path(value).suffix.lower() in extensions, 'SCOPE_INVALID', 'Unsupported file extension: '+value)
    discovered = source_scanner.discover_shops(source['root'])
    if discovered['errors']:
        raise RunSyncError('SCOPE_DISCOVERY_FAILED', 'Cannot discover shops', {'errors': discovered['errors']})
    selected_shops = sorted(set(discovered['shops'] if all_shops else shop_values))
    missing = sorted(set(selected_shops) - set(discovered['shops']))
    if missing:
        raise RunSyncError('SHOP_NOT_FOUND', 'Explicit shops do not exist', {'shops': missing})
    catalogues = {s: _scope_catalogue(source['root'], s, extensions) for s in selected_shops}
    directories = set().union(*(c[0] for c in catalogues.values()))
    families = {}
    for schema in config['schema_registry']['schemas']:
        families.setdefault(schema['report_name'], []).append(schema['match'])
    def named(value, available, dimension):
        if value in available:
            return value
        candidates = sorted(v for v in available if '/' not in value and v.rsplit('/', 1)[-1] == value)
        if len(candidates) != 1:
            raise RunSyncError('SCOPE_AMBIGUOUS' if candidates else 'SCOPE_NOT_FOUND',
                               'Name must resolve uniquely', {'dimension': dimension, 'value': value, 'candidates': candidates})
        return candidates[0]
    selected_folders = sorted({named(v, directories, 'folders') for v in folder_values})
    selected_reports = sorted({named(v, families, 'reports') for v in report_values})
    selected_files = sorted(set(file_values))
    all_files = {p for _, paths in catalogues.values() for p in paths}
    for value in selected_files:
        if value not in all_files:
            raise RunSyncError('SCOPE_NOT_FOUND', 'Explicit file does not exist', {'file': value})
    selectors = dict(folders=selected_folders, reports=selected_reports, dates=day_values,
                     date_ranges=[list(r) for r in sorted(ranges)], files=selected_files)
    filtered = any(selectors.values())
    temporal = [('dates', v, (v, v)) for v in day_values] + [('date_ranges', r, r) for r in sorted(ranges)]
    hits = {(dim, str(v)): 0 for dim, values in selectors.items() if dim not in ('dates', 'date_ranges') for v in values}
    hits.update({(dim, str(v)): 0 for dim, v, _ in temporal})
    def report_matches(path, report):
        parent, _, filename = path.rpartition('/')
        stem, extension = os.path.splitext(filename)
        return any(parent == rule['directory'] and (not rule.get('stem') or stem == rule['stem'])
                   and extension.lower() in rule['extensions'] for rule in families[report])
    selected_paths = {}
    for shop, (_, paths) in catalogues.items():
        chosen = []
        for path in paths:
            matches = {
                'folders': [v for v in selected_folders if path.startswith(v + '/')],
                'reports': [v for v in selected_reports if report_matches(path, v)],
                'files': [v for v in selected_files if path == v],
            }
            if any(selectors[dim] and not values for dim, values in matches.items()):
                continue
            time_matches = []
            if temporal:
                period = parse_file_period(path)
                if period:
                    time_matches = [(dim, value) for dim, value, pair in temporal
                                    if pair == (period['start'], period['end'])]
                if not time_matches:
                    continue
            chosen.append(path)
            for dim, values in matches.items():
                for value in values:
                    hits[(dim, str(value))] += 1
            for dim, value in time_matches:
                hits[(dim, str(value))] += 1
        selected_paths[shop] = chosen
    unmatched = [dict(dimension=dim, value=value) for (dim, value), count in hits.items() if count == 0]
    if unmatched:
        raise RunSyncError('SCOPE_NO_MATCH', 'Some explicit conditions have no combined match; undated summaries require selecting the whole file', {'conditions': unmatched})
    empty = [s for s in selected_shops if not selected_paths[s]]
    return dict(mode='filtered' if filtered else 'full_shop', shops=selected_shops, selectors=selectors,
                selected_paths=selected_paths, selected_count=sum(map(len, selected_paths.values())),
                empty_shops=empty, warnings=[dict(shop=s, warning='NO_SELECTED_FILES') for s in empty])


def _config(config):
    """Validate paths without opening sources or changing the registry object."""
    try:
        _require(isinstance(config, dict), 'CONFIG_INVALID', 'Expected config object')
        for key in ('source', 'state', 'target', 'schema_registry'):
            _require(isinstance(config.get(key), dict), 'CONFIG_INVALID', 'Missing '+key)
        source, state, target = config['source'], config['state'], config['target']
        def local(value):
            _require(isinstance(value, str) and bool(value), 'CONFIG_INVALID', 'Missing local path')
            def expand(match):
                replacement = os.environ.get(match[1])
                _require(bool(replacement), 'CONFIG_INVALID', 'Missing environment variable '+match[1])
                return replacement
            value = re.sub(r'\$\{([^}]+)\}', expand, value).replace('\\', os.sep).replace('/', os.sep)
            _require('$' not in value and '\x00' not in value and Path(value).is_absolute(), 'CONFIG_INVALID', 'Local paths must be absolute')
            return str(Path(value))
        source_root, state_root = local(source.get('root')), local(state.get('root'))
        resolved_source, resolved_state = Path(source_root).resolve(), Path(state_root).resolve()
        _require(resolved_source != resolved_state and resolved_source not in resolved_state.parents,
                 'CONFIG_INVALID', 'State must be outside source root')
        extensions = source.get('supported_extensions')
        _require(isinstance(extensions, list) and set(extensions) == {'.xlsx', '.csv'} and len(extensions) == 2,
                 'CONFIG_INVALID', 'Expected XLSX/CSV extensions')
        capacity = target.get('max_formal_tables_per_base')
        _require(type(capacity) is int and 1 <= capacity <= 290, 'CONFIG_INVALID', 'Capacity must be an integer in 1..290')
        path = target.get('parent_folder_path')
        _require(isinstance(path, str) and path.startswith('/') and '\\' not in path and '\x00' not in path
                 and all(p not in ('', '.', '..') for p in path[1:].split('/')), 'CONFIG_INVALID', 'Invalid absolute cloud parent path')
        _require(target.get('base_name_template') == '广告数据部_{shop_name}_V{volume:03d}', 'CONFIG_INVALID', 'Unexpected Base name template')
        registry = config['schema_registry']
        _require(isinstance(registry.get('version'), str) and bool(registry['version'])
                 and isinstance(registry.get('schemas'), list) and bool(registry['schemas']), 'CONFIG_INVALID', 'Invalid schema registry')
        return dict(config, source=dict(source, root=source_root), state=dict(state, root=state_root))
    except RunSyncError:
        raise
    except (TypeError, ValueError, OSError, KeyError) as exc:
        raise RunSyncError('CONFIG_INVALID', str(exc)) from exc


def load_sync_config(config_path=None):
    """Load the Skill-local JSON-compatible YAML, accepting UTF-8 BOM."""
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ValueError('Duplicate config key: '+key)
            obj[key] = value
        return obj
    path = Path(config_path) if config_path is not None else Path(__file__).resolve().parent.parent / 'config/sync.yaml'
    try:
        return _config(json.loads(path.read_text(encoding='utf-8-sig'), object_pairs_hook=pairs))
    except RunSyncError:
        raise
    except (OSError, ValueError, TypeError) as exc:
        raise RunSyncError('CONFIG_INVALID', str(exc)) from exc


def _jsonable(value):
    if isinstance(value, Decimal):
        return {'$decimal': str(value)}
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(v) for v in value]
    return value


def _chain(exc):
    seen, pending = set(), [exc]
    while pending:
        item = pending.pop()
        if item is None or id(item) in seen:
            continue
        seen.add(id(item))
        yield item
        pending.extend([getattr(item, 'cause', None), getattr(item, '__cause__', None)])


def _has_unknown(value):
    if isinstance(value, dict):
        return value.get('result_state') == 'unknown' or any(_has_unknown(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return any(_has_unknown(v) for v in value)
    return False


def _auth(exc):
    return any(getattr(e, 'code', None) == 'AUTH_ERROR' or getattr(e, 'http_status', None) == 401 for e in _chain(exc))


def _missing(exc):
    return not _auth(exc) and (getattr(exc, 'code', None) == 'NOT_FOUND' or getattr(exc, 'http_status', None) == 404)


def _error(exc, **location):
    result = dict(location, error=getattr(exc, 'code', type(exc).__name__), detail=getattr(exc, 'detail', str(exc)))
    context = deepcopy(getattr(exc, 'context', {}))
    result['context'] = context
    for key in ('phase', 'table_id'):
        if key in context:
            result[key] = context[key]
    for key in ('operation', 'http_status', 'api_code', 'request_id', 'raw_error'):
        if hasattr(exc, key):
            result[key] = deepcopy(getattr(exc, key))
    causes = list(_chain(exc))[1:]
    if causes:
        result['causes'] = [{
            'error': getattr(e, 'code', type(e).__name__), 'detail': getattr(e, 'detail', str(e)),
            'context': deepcopy(getattr(e, 'context', {})), 'http_status': getattr(e, 'http_status', None),
            'api_code': getattr(e, 'api_code', None), 'request_id': getattr(e, 'request_id', None),
            'raw_error': deepcopy(getattr(e, 'raw_error', None)),
        } for e in causes]
    return _jsonable(result)


class _ShopRun:
    """In-memory facts for one held shop lock, with no recovery persistence."""
    def __init__(self, config, shop, client, reader, writer, store, selected_paths=None):
        self.selected_paths = selected_paths
        self.config, self.shop = config, shop
        self.client, self.reader, self.writer, self.store = client, reader, writer, store
        self.output = dict(shop=shop, errors=[], warnings=[], files=[])
        self.files, self.inventory, self.initial = {}, {}, {}
        self.stop_shop = self.auth_failed = False
        self.stopped_volumes = set()
        self.parent_checked, self.parent_token = False, None
        self.phase = 'state_precheck'

    def rpc(self, operation, *args, **kwargs):
        self.phase = operation
        return getattr(self.client, operation)(*args, **kwargs)

    def parent(self, create=False):
        if not self.parent_checked or (create and self.parent_token is None):
            try:
                resolved = self.rpc('resolve_parent_folder', self.config['target']['parent_folder_path'], create_missing=create)
                self.parent_token = resolved['folder_token']
            except Exception as exc:
                if create or not _missing(exc):
                    raise
                self.parent_token = None
            self.parent_checked = True
        return self.parent_token

    def list_tables(self, token):
        result = self.rpc('list_tables', token)
        tables = result.get('tables') if isinstance(result, dict) else None
        valid = isinstance(tables, list) and type(result.get('table_count')) is int and result['table_count'] == len(tables)
        valid = valid and all(isinstance(t, dict) and all(isinstance(t.get(k), str) and t[k] for k in ('table_id', 'table_name')) for t in tables)
        _require(valid and len({t['table_id'] for t in tables}) == len(tables), 'INVALID_RESPONSE', 'Incomplete table inventory')
        return result

    def save_token(self, volume, token):
        self.phase = 'set_base_token'
        try:
            self.store.set_base_token(self.shop, volume, token)
        except Exception:
            self.stop_shop = True
            raise

    def observe(self, volume, snapshot):
        historical = volume in snapshot['volumes']
        old_token = snapshot['volumes'].get(volume, {}).get('base_token')
        name = self.config['target']['base_name_template'].format(shop_name=self.shop, volume=int(volume[1:]))
        token = None
        if old_token:
            try:
                result = self.rpc('get_base', old_token)
                _require(isinstance(result, dict) and result.get('base_token') == old_token and isinstance(result.get('base_name'), str),
                         'INVALID_RESPONSE', 'Base response lacks identity/name')
                if result['base_name'] == name:
                    token = old_token
            except Exception as exc:
                if not _missing(exc):
                    raise
        if token is None:
            parent = self.parent()
            found = self.rpc('find_base_by_name', parent, name) if parent is not None else None
            if found is not None:
                _require(isinstance(found, dict) and found.get('base_name') == name and isinstance(found.get('base_token'), str) and bool(found['base_token']),
                         'INVALID_RESPONSE', 'Base lookup identity differs')
                token = found['base_token']
        if token is None:
            _require(not historical, 'BASE_RESOLVE_FAILED', 'Historical Base was not found; no automatic rebuild')
            return dict(status='NOT_FOUND', complete=True)
        tables = self.list_tables(token)
        if token != old_token:
            self.save_token(volume, token)
        return dict(status='READY', complete=True, base_token=token, **tables)

    def disposition(self, path, status, **facts):
        self.files[path] = dict(self.files.get(path, {}), local_path=path, status=status, **facts)

    def diagnose(self, exc, *, volume=None, path=None, table_id=None, base_token=None, warning=False):
        location = dict(scope='file' if path else 'base' if volume else 'task', phase=self.phase)
        if volume:
            location['volume'] = volume
        if path:
            location['local_path'] = path
        if table_id is not None:
            location['table_id'] = table_id
        if base_token is not None:
            location['base_token'] = base_token
        error = _error(exc, **location)
        self.output['warnings' if warning else 'errors'].append(error)
        if _auth(exc):
            self.auth_failed = True
        return error

    def create_base(self, volume, name):
        parent = self.parent(create=True)
        result = self.rpc('create_base', parent, name)
        token = result.get('base_token')
        _require(isinstance(token, str) and bool(token) and result.get('base_name') == name, 'INVALID_RESPONSE', 'Created Base identity missing')
        self.inventory[volume] = dict(status='READY', base_token=token)
        self.save_token(volume, token)
        listed = self.list_tables(token)
        ids = [t['table_id'] for t in listed['tables']]
        default = result.get('default_table_id')
        _require(len(ids) <= 1 and (default is None or ids == [default]),
                 'BASE_INITIAL_TABLES_UNRESOLVED', 'New Base initial tables are not uniquely explained')
        self.initial[volume] = ids[0] if ids else None
        self.inventory[volume].update(complete=True, **listed)
        return token

    def cleanup_initial(self, volume, token):
        initial = self.initial.pop(volume, None)
        if initial is None:
            return
        try:
            self.rpc('delete_table', token, initial)
            _require(initial not in {t['table_id'] for t in self.list_tables(token)['tables']},
                     'BASE_INITIAL_TABLE_CLEANUP_FAILED', 'Initial table deletion not confirmed')
        except Exception as exc:
            self.diagnose(exc, volume=volume, base_token=token, table_id=initial, warning=True)

    def execute_action(self, action, volume, name, snapshot):
        path = action['relative_path']
        old = snapshot['by_local_path'].get(path)
        token = self.inventory.get(volume, {}).get('base_token')
        table_id = old['table_id'] if old and action['action'] == 'REPLACE' else None
        try:
            self.phase = 'read_source'
            meta = {key: action[key] for key in ('absolute_path', 'relative_path', 'extension', 'file_hash')}
            parsed = self.reader(meta, registry=self.config['schema_registry'])
            if not isinstance(parsed, dict) or parsed.get('status') != 'OK' or not isinstance(parsed.get('baseline'), dict):
                issues = parsed.get('errors') if isinstance(parsed, dict) else None
                if not isinstance(issues, list) or not issues:
                    issues = [{'error': 'READER_RESULT_INVALID'}]
                for issue in issues:
                    self.output['errors'].append(_jsonable(dict(issue, scope='file', local_path=path, volume=volume, phase='read_source')))
                self.disposition(path, 'FAILED')
                return
            baseline = parsed['baseline']
            if token is None:
                try:
                    token = self.create_base(volume, name)
                except Exception:
                    self.stopped_volumes.add(volume)
                    raise
            if action['action'] == 'CREATE':
                try:
                    actual = self.list_tables(token)
                except Exception:
                    self.stopped_volumes.add(volume)
                    raise
                _require(actual['table_count'] < 300, 'BASE_CAPACITY_EXCEEDED', 'Base has reached 300 physical tables')
            self.phase = 'write_table'
            written = self.writer(self.client, token, action['target_table_name'], action['target_folder_path'], baseline,
                                  existing_table_id=table_id)
            returned_id = written.get('table_id') if isinstance(written, dict) else None
            expected = dict(status='WRITTEN', action=action['action'], relative_path=path,
                            file_hash=action['file_hash'], base_token=token, table_name=action['target_table_name'],
                            folder_path=action['target_folder_path'], schema_key=baseline.get('schema_key'),
                            schema_version=baseline.get('schema_version'))
            valid = isinstance(written, dict) and all(written.get(k) == v for k, v in expected.items())
            valid = valid and isinstance(returned_id, str) and bool(returned_id) and (table_id is None or table_id == returned_id)
            if not valid:
                raise RunSyncError('WRITER_RESULT_INVALID', 'Writer did not confirm this exact file/action',
                                   {'phase': self.phase, 'table_id': returned_id, 'writer_result': written})
            table_id = returned_id
            self.phase = 'commit_mapping'
            try:
                if old is None:
                    self.store.commit_new_mapping(self.shop, volume, path, table_id, action['file_hash'])
                else:
                    self.store.commit_existing_mapping(self.shop, volume, path, old['table_id'], old['file_hash'], table_id, action['file_hash'])
            except Exception:
                self.stop_shop = True
                raise
            self.disposition(path, 'CREATED' if action['action'] == 'CREATE' else 'REPLACED',
                             base_token=token, table_id=table_id, table_name=action['target_table_name'],
                             schema_key=written['schema_key'], display_adjustments=deepcopy(written.get('display_adjustments', [])))
            self.cleanup_initial(volume, token)
        except Exception as exc:
            token = token or self.inventory.get(volume, {}).get('base_token')
            error = self.diagnose(exc, volume=volume, path=path, table_id=table_id, base_token=token)
            self.disposition(path, 'FAILED', base_token=token, table_id=error.get('table_id', table_id))
            if any(_has_unknown(getattr(e, 'context', {})) for e in _chain(exc)):
                self.stopped_volumes.add(volume)

    def process(self, snapshot):
        source = self.config['source']
        self.phase = 'scan_shop'
        scope_args = {} if self.selected_paths is None else {'selected_paths': self.selected_paths}
        scan = source_scanner.scan_shop(source['root'], self.shop, source['supported_extensions'], **scope_args)
        scanned = {f['relative_path'] for f in scan['files']}
        scan['path_presence'] = {}
        historical = set(snapshot['by_local_path']) if self.selected_paths is None else set()
        for path in sorted(historical - scanned):
            presence = source_scanner.check_path_presence(source['root'], self.shop, path)
            scan['path_presence'][path] = presence['status']
            if presence.get('error') and not any(e.get('relative_path') == path for e in scan['errors']):
                scan['errors'].append(dict(error=presence['error'], relative_path=path))
        capacity = self.config['target']['max_formal_tables_per_base']
        for volume in required_volumes(scan, snapshot, capacity, **scope_args):
            if self.auth_failed or self.stop_shop:
                break
            try:
                self.inventory[volume] = self.observe(volume, snapshot)
            except Exception as exc:
                self.inventory[volume] = dict(status='ERROR', error=_error(exc, scope='base', phase=self.phase))
                if _auth(exc):
                    self.auth_failed = True
        plan = plan_sync(self.shop, scan, snapshot, self.inventory,
                         self.config['target']['base_name_template'], capacity, **scope_args)
        for path, volume in plan['file_volumes'].items():
            self.disposition(path, 'NOT_STARTED', volume=volume)
        for item in plan['errors']:
            error = deepcopy(item)
            path = error.get('relative_path')
            if path:
                error['local_path'] = path
                self.disposition(path, 'FAILED', volume=error.get('volume', plan['file_volumes'].get(path)))
            self.output['errors'].append(_jsonable(error))
        for key, status in (('unchanged', 'UNCHANGED'), ('remote_orphans', 'REMOTE_ORPHAN')):
            for item in plan[key]:
                path, volume = item['relative_path'], item['volume']
                self.disposition(path, status, volume=volume, base_token=self.inventory[volume]['base_token'],
                                 table_id=item['table_id'], table_name=build_target_table_name(path))
        for queue in plan['base_queues']:
            volume = queue['volume']
            for action in queue['actions']:
                if self.auth_failed or self.stop_shop or volume in self.stopped_volumes:
                    continue
                self.execute_action(action, volume, queue['base_name'], snapshot)

    def execute(self):
        try:
            with self.store.acquire_shop_execution_lock(self.shop):
                snapshot = self.store.prepare_shop_state(self.shop)
                self.process(snapshot)
        except Exception as exc:
            self.diagnose(exc)
        self.output['files'] = [self.files[p] for p in sorted(self.files)]
        for status, count in (('CREATED', 'created'), ('REPLACED', 'replaced'), ('UNCHANGED', 'unchanged'),
                              ('REMOTE_ORPHAN', 'remote_orphan'), ('FAILED', 'failed'), ('NOT_STARTED', 'not_started')):
            self.output[count] = sum(f['status'] == status for f in self.output['files'])
        return self.output


def run_sync(config, *, shops=None, all_shops=False, folders=None, reports=None,
             dates=None, date_ranges=None, files=None, preview=False,
             client=None, reader=None, writer=None, store=None):
    """Run selected shops serially and return one JSON-compatible summary."""
    result = dict(status='FAILED', errors=[], shops=[])
    try:
        config = _config(config)
        _require(type(preview) is bool, 'SCOPE_INVALID', 'Expected Boolean preview')
        scope = None
        if preview or any(v is not None and v != [] and v != () for v in (folders, reports, dates, date_ranges, files)):
            scope = resolve_scope(config, shops=shops, all_shops=all_shops, folders=folders,
                                  reports=reports, dates=dates, date_ranges=date_ranges, files=files)
            result['scope'] = scope
            if preview:
                result['status'] = 'PREVIEW'
                return result
        _require(type(all_shops) is bool and (all_shops != bool(shops)), 'SCOPE_INVALID', 'Select --all or one or more --shop')
        _require(shops is None or isinstance(shops, (list, tuple)) and all(isinstance(s, str) and bool(s) for s in shops),
                 'SCOPE_INVALID', 'Expected shop names')
        discovered = source_scanner.discover_shops(config['source']['root'])
        if discovered['errors']:
            result['errors'] = deepcopy(discovered['errors'])
            return result
        selected = sorted(set(discovered['shops'] if all_shops else shops))
        absent = [s for s in selected if s not in discovered['shops']]
        if absent:
            result['errors'] = [dict(error='SHOP_NOT_FOUND', shop=s) for s in absent]
            return result
        client = BitableClient() if client is None else client
        reader = read_source if reader is None else reader
        writer = write_table if writer is None else writer
        store = StateStore(config['state']['root'], config['target']['max_formal_tables_per_base']) if store is None else store
        auth_failed = False
        for shop in selected:
            paths = scope['selected_paths'][shop] if scope and scope['mode'] == 'filtered' else None
            if paths == []:
                continue
            execution = _ShopRun(config, shop, client, reader, writer, store, selected_paths=paths)
            result['shops'].append(execution.execute())
            if execution.auth_failed:
                auth_failed = True
                result['errors'].append(dict(error='AUTH_ERROR', scope='task', detail='Authentication interrupted the run; remaining shops were not enumerated',
                                             not_started_shops=selected[selected.index(shop) + 1:]))
                break
        problems = any(s['errors'] or s['warnings'] or s['failed'] or s['not_started'] for s in result['shops'])
        completed = any(s['created'] or s['replaced'] or s['unchanged'] or s['remote_orphan'] for s in result['shops'])
        result['status'] = 'FAILED' if auth_failed else ('PARTIAL_SUCCESS' if completed else 'FAILED') if problems else 'SUCCESS'
    except Exception as exc:
        result['errors'].append(_error(exc, scope='task'))
    return _jsonable(result)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise RunSyncError('ARGUMENT_INVALID', message)


def main(argv=None, *, config_path=None, client=None, reader=None, writer=None, store=None):
    parser = _Parser(description='Upload selected shops using fixed typed schemas', allow_abbrev=False)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--shop', action='append', dest='shops')
    group.add_argument('--all', action='store_true', dest='all_shops')
    for flag, dest in (('folder', 'folders'), ('report', 'reports'), ('file', 'files'), ('date', 'dates')):
        parser.add_argument('--'+flag, action='append', dest=dest)
    parser.add_argument('--date-range', action='append', nargs=2, dest='date_ranges')
    parser.add_argument('--preview', action='store_true')
    try:
        args = parser.parse_args(argv)
        result = run_sync(load_sync_config(config_path), shops=args.shops, all_shops=args.all_shops,
                          folders=args.folders, reports=args.reports, dates=args.dates,
                          date_ranges=args.date_ranges, files=args.files, preview=args.preview,
                          client=client, reader=reader, writer=writer, store=store)
    except SystemExit as exc:
        if exc.code == 0:
            return 0
        result = dict(status='FAILED', errors=[dict(error='ARGUMENT_INVALID')], shops=[])
    except Exception as exc:
        result = dict(status='FAILED', errors=[_error(exc, scope='task')], shops=[])
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] in ('SUCCESS', 'PREVIEW') else 1


if __name__ == '__main__':
    raise SystemExit(main())
