"""Write one typed baseline through the public client; no retries or state writes."""
from copy import deepcopy
from decimal import Decimal
import re

from bitable_client import build_field_definition


class TableWriterError(Exception):
    def __init__(self, code, detail, context, cause=None):
        self.code, self.detail = code, detail
        self.context = deepcopy(context)
        self.cause = cause
        super().__init__(f'{code}: {detail}')


def _validate(base, name, path, baseline, existing):
    def check(ok, detail):
        if not ok:
            raise ValueError(detail)

    def text(value, nonempty=True):
        check(isinstance(value, str) and (bool(value) or not nonempty), 'Expected string')
        value.encode('utf-8')

    text(base)
    check(re.fullmatch(r'[A-Za-z0-9_-]+', base), 'Invalid Base identity')
    if existing is not None:
        text(existing)
        check(re.fullmatch(r'[A-Za-z0-9_-]+', existing), 'Invalid table identity')
    text(name)
    check(len(name) <= 100, 'Table name exceeds 100 characters')
    text(path, False)
    check(not path.startswith('/') and '\\' not in path and ':' not in path, 'Invalid relative folder path')
    check(path == '' or (len(path.split('/')) <= 2 and all(p not in ('', '.', '..') for p in path.split('/'))), 'Invalid folder depth or component')
    check(isinstance(baseline, dict), 'Expected typed baseline')
    check(baseline.get('write_mode') == 'typed_schema_v1', 'Expected typed_schema_v1')
    for key in ('schema_key', 'schema_version', 'relative_path', 'file_hash'):
        text(baseline.get(key))
    fields, rows = baseline.get('target_fields'), baseline.get('source_records')
    check(isinstance(fields, list) and bool(fields), 'Expected nonempty target_fields')
    check(isinstance(rows, list), 'Expected source_records')
    for key in ('column_count', 'target_field_count', 'effective_record_count'):
        check(type(baseline.get(key)) is int and baseline[key] >= 0, 'Invalid count: '+key)
    check(baseline['target_field_count'] == len(fields) and baseline['effective_record_count'] == len(rows), 'Count mismatch')
    keys, names, source_indices, companions, definitions, adjustments = [], [], [], [], [], []
    for field in fields:
        check(isinstance(field, dict), 'Invalid field declaration')
        for key in ('field_key', 'field_name'):
            text(field.get(key))
        keys.append(field['field_key'])
        names.append(field['field_name'])
        check(type(field.get('hidden')) is bool and type(field.get('derived')) is bool, 'Invalid visibility/derived declaration')
        check(type(field.get('source_index')) is int and field['source_index'] > 0, 'Invalid source_index')
        if field['derived']:
            check(field['hidden'] and field['field_type'] == 'Number', 'Invalid companion declaration')
            companions.append(field['source_index'])
        else:
            check(not companions, 'Source fields must precede companions')
            source_indices.append(field['source_index'])
        built = build_field_definition(field)
        definitions.append(built['definition'])
        adjustments.extend(built['display_adjustments'])
    check(len(set(keys)) == len(keys) and len(set(names)) == len(names), 'Duplicate field key/name')
    check(source_indices == list(range(1, baseline['column_count'] + 1)), 'Source column count/order mismatch')
    check(len(set(companions)) == len(companions) and set(companions) <= set(source_indices), 'Invalid companion source identity')
    check(baseline.get('visible_field_keys') == [f['field_key'] for f in fields if not f['hidden']], 'Visible field order mismatch')
    for row_index, row in enumerate(rows):
        check(isinstance(row, dict) and isinstance(row.get('values'), list) and len(row['values']) == len(fields), f'Invalid values at record {row_index}')
        for field, value in zip(fields, row['values']):
            if value is None:
                continue
            typ = field['field_type']
            check(type(value) is {'Text': str, 'Number': Decimal, 'DateTime': int, 'Boolean': bool}[typ], f'Invalid value type at record {row_index}, field {field["field_key"]}')
            if typ == 'Text':
                value.encode('utf-8')
            if typ == 'Number':
                check(value.is_finite(), 'Nonfinite Decimal')
                check(not (field['format']['kind'] == 'currency' and field['format'].get('currency') is None), 'Nonempty amount without currency')
    return definitions, adjustments


def write_table(client, base_token, target_table_name, target_folder_path,
                source_baseline, *, existing_table_id=None):
    """Create or replace records in one table, keeping existing table/field IDs."""
    b = source_baseline
    context = dict(phase='validate_input', base_token=base_token,
                   relative_path=b.get('relative_path') if isinstance(b, dict) else None,
                   schema_key=b.get('schema_key') if isinstance(b, dict) else None,
                   table_id=existing_table_id, deleted_record_count=0, created_record_count=0)

    def fail(code, detail):
        raise TableWriterError(code, detail, context)

    def require(ok, code, detail):
        if not ok:
            fail(code, detail)

    def call(operation, *args, **kwargs):
        context['phase'] = operation
        try:
            return getattr(client, operation)(base_token, *args, **kwargs)
        except Exception as exc:
            context['client_context'] = deepcopy(getattr(exc, 'context', {}))
            if operation in ('batch_create_records', 'batch_delete_records'):
                key = 'created_record_count' if operation == 'batch_create_records' else 'deleted_record_count'
                # A failed batch call may have partially committed. Preserve uncertainty.
                context[key] = None
                confirmed = context['client_context'].get('confirmed_record_ids')
                if isinstance(confirmed, list):
                    context['confirmed_'+key] = len(confirmed)
            raise TableWriterError('CLIENT_OPERATION_FAILED', str(exc), context, exc) from exc

    try:
        definitions, adjustments = _validate(base_token, target_table_name, target_folder_path, b, existing_table_id)
    except Exception as exc:
        raise TableWriterError('WRITER_INPUT_INVALID', str(exc), context, exc) from exc

    tables = call('list_tables')['tables']
    creating = existing_table_id is None
    folder_id = None
    created_view = None
    if creating:
        require(not any(t['table_name'] == target_table_name for t in tables), 'TARGET_TABLE_NAME_CONFLICT', 'Target name already exists')
        if target_folder_path:
            folder_id = call('resolve_folder_path', target_folder_path, create_missing=True)['folder_id']
        created = call('create_table', target_table_name, definitions)
        context['table_id'] = created.get('table_id')
        require(isinstance(context['table_id'], str) and bool(context['table_id']), 'WRITE_RESULT_MISMATCH', 'Missing created table ID')
        created_view = created.get('default_view_id')
    else:
        matches = [t for t in tables if t['table_id'] == existing_table_id]
        require(len(matches) == 1 and matches[0]['table_name'] == target_table_name, 'TABLE_TARGET_MISMATCH', 'Existing table identity/name differs')
        blocks = call('list_blocks')
        for component in target_folder_path.split('/') if target_folder_path else []:
            matches = [x for x in blocks if x['block_type'] == 'folder' and x['name'] == component and x.get('parent_id') == folder_id]
            require(len(matches) == 1, 'TABLE_TARGET_MISMATCH', 'Target folder path does not uniquely exist')
            folder_id = matches[0]['block_id']
        matches = [x for x in blocks if x['block_id'] == existing_table_id and x['block_type'] == 'table']
        require(len(matches) == 1 and matches[0].get('parent_id') == folder_id, 'TABLE_TARGET_MISMATCH', 'Existing table folder differs')

    tid = context['table_id']
    fields = call('list_fields', tid)
    code = 'REMOTE_SCHEMA_MISMATCH'
    require(len({f['field_name'] for f in fields}) == len(fields) and len({f['field_id'] for f in fields}) == len(fields), code, 'Duplicate remote field identity/name')
    by_name = {f['field_name']: f for f in fields}
    require(not creating or len(fields) == len(definitions), code, 'Created field set differs')
    mapping, pending, retained_currency = {}, [], set()
    for decl, definition in zip(b['target_fields'], definitions):
        remote = by_name.get(decl['field_name'])
        require(remote is not None and remote['type'] == definition['type'], code, 'Missing or differently typed field: '+decl['field_name'])
        fid = remote['field_id']
        mapping[decl['field_key']] = fid
        prop = remote.get('property') or {}
        expected = definition.get('property') or {}
        fmt = decl['format']
        if decl['field_type'] == 'DateTime':
            require(prop.get('date_formatter') == expected['date_formatter'] and prop.get('auto_fill', False) is False, code, 'Date format differs: '+decl['field_name'])
        elif decl['field_type'] == 'Number':
            currency = prop.get('currency_code')
            subtype = remote.get('ui_type')
            if fmt['kind'] == 'currency':
                wanted = fmt.get('currency')
                if wanted is not None:
                    if currency is None and subtype != 'Currency' and not creating:
                        pending.append((fid, definition))
                    else:
                        require(currency == wanted and subtype == 'Currency', code, 'Currency differs: '+decl['field_name'])
                elif currency is not None:
                    require(not creating and subtype == 'Currency', code, 'Unexpected currency configuration')
                    retained_currency.add(decl['field_name'])
                else:
                    require(subtype != 'Currency', code, 'Currency subtype has no currency')
            else:
                require(currency is None and subtype not in ('Currency', 'Percentage'), code, 'Unexpected numeric semantics: '+decl['field_name'])
            formatter = prop.get('formatter')
            if fmt['pattern'] == 'General':
                require(formatter in (None, '', 'General') or (isinstance(formatter, str) and re.fullmatch(r'0(?:\.0+)?', formatter)), code, 'Unexpected General formatter')
            else:
                require(formatter == expected.get('formatter'), code, 'Number formatter differs: '+decl['field_name'])
    managed = set(mapping.values())
    extras = [f['field_id'] for f in fields if f['field_id'] not in managed]
    if retained_currency:
        adjustments = [a for a in adjustments if not (a['field_name'] in retained_currency and a['requested'] == 'currency=None')]
    views = call('list_views', tid)
    grids = [v for v in views if v.get('type') == 'grid']
    if creating:
        chosen = [v for v in grids if v['view_id'] == created_view]
    else:
        marked = [v for v in grids if v.get('is_default', (v.get('raw') or {}).get('is_default')) is True]
        chosen = marked if marked else grids
    require(len(chosen) == 1, 'DEFAULT_GRID_VIEW_UNRESOLVED', 'Default grid is not uniquely identified')
    view_id = chosen[0]['view_id']
    visible = call('get_visible_fields', tid, view_id)
    require(isinstance(visible, list) and len(set(visible)) == len(visible) and set(visible) <= {f['field_id'] for f in fields}, code, 'Invalid visible field identities')
    desired = [mapping[k] for k in b['visible_field_keys']] + [fid for fid in visible if fid not in managed]

    def record_ids(rows):
        require(isinstance(rows, list) and all(isinstance(r, dict) and isinstance(r.get('record_id'), str) and r['record_id'] for r in rows), 'WRITE_RESULT_MISMATCH', 'Invalid record identities')
        ids = [r['record_id'] for r in rows]
        require(len(set(ids)) == len(ids), 'WRITE_RESULT_MISMATCH', 'Duplicate record IDs')
        return ids

    projection = next(iter(mapping.values()))
    old_ids = []
    if not creating:
        selected = list(dict.fromkeys([projection] + [fid for fid, _ in pending]))
        old_rows = call('list_records', tid, selected)
        old_ids = record_ids(old_rows)
        for fid, _ in pending:
            require(all(r['fields'].get(fid) is None or r['fields'].get(fid) == '' for r in old_rows), code, 'Existing amount without currency is nonempty: '+fid)
    updated = []
    for fid, definition in pending:
        call('update_field', tid, fid, definition)
        updated.append(fid)
    if creating and folder_id is not None:
        call('move_table', tid, folder_id)
    if visible != desired:
        actual = call('set_visible_fields', tid, view_id, desired)
        require(actual == desired, 'WRITE_RESULT_MISMATCH', 'Visible field update differs')

    def batch_ids(response, key, count, expected=None):
        require(isinstance(response, dict), 'WRITE_RESULT_MISMATCH', 'Invalid batch result')
        ids = response.get('record_ids')
        require(type(response.get(key)) is int and response[key] == count and isinstance(ids, list) and len(ids) == count and all(isinstance(x, str) and x for x in ids), 'WRITE_RESULT_MISMATCH', 'Batch result count/IDs differ')
        require(len(set(ids)) == len(ids) and (expected is None or set(ids) == set(expected)), 'WRITE_RESULT_MISMATCH', 'Batch result ID set differs')
        return ids

    if old_ids:
        context['deleted_record_count'] = None
        response = call('batch_delete_records', tid, old_ids)
        batch_ids(response, 'deleted_count', len(old_ids), old_ids)
        context['deleted_record_count'] = len(old_ids)
    new_ids = []
    if b['source_records']:
        payload = [{'fields': {mapping[f['field_key']]: value for f, value in zip(b['target_fields'], row['values'])}} for row in b['source_records']]
        context['created_record_count'] = None
        response = call('batch_create_records', tid, payload)
        new_ids = batch_ids(response, 'created_count', b['effective_record_count'])
        context['created_record_count'] = len(new_ids)
    final_ids = record_ids(call('list_records', tid, [projection]))
    require(set(final_ids) == set(new_ids) and len(final_ids) == b['effective_record_count'], 'WRITE_RESULT_MISMATCH', 'Final record set/count differs')
    return dict(status='WRITTEN', action='CREATE' if creating else 'REPLACE',
                base_token=base_token, table_id=tid, table_name=target_table_name,
                folder_id=folder_id, folder_path=target_folder_path,
                relative_path=b['relative_path'], file_hash=b['file_hash'],
                schema_key=b['schema_key'], schema_version=b['schema_version'],
                field_map=mapping, default_grid_view_id=view_id, visible_field_ids=desired,
                created_record_count=len(new_ids), deleted_record_count=len(old_ids),
                final_record_count=len(final_ids), preserved_extra_field_ids=extras,
                updated_field_ids=updated, display_adjustments=adjustments)
