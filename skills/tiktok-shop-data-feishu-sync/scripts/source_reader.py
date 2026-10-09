"""Read complete business records using the configured, fixed typed schemas.

No remote operations or type inference. Decimal values deliberately remain Decimal
until the API serialization boundary in a later stage.
"""
import csv
import datetime as dt
from decimal import Decimal, InvalidOperation, localcontext, ROUND_HALF_UP
from copy import deepcopy
from pathlib import Path, PurePosixPath
import json
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET


class _SourceError(Exception):
    def __init__(self, code, detail='', **context):
        super().__init__(detail or code)
        self.code, self.context = code, context


def load_schema_registry(config_path=None):
    """Return the registry from this Skill's config, or an explicit config path."""
    path = Path(config_path) if config_path is not None else Path(__file__).resolve().parents[1] / 'config/sync.yaml'
    with path.open(encoding='utf-8') as stream:
        return json.load(stream)['schema_registry']


def _child(node, name):
    return next((x for x in node if x.tag.rsplit('}', 1)[-1] == name), None)


def _text(node):
    if node is None:
        return None
    return ''.join(t.text or '' for c in node if c.tag.rsplit('}', 1)[-1] in {'t', 'r'}
                   for t in c.iter() if t.tag.rsplit('}', 1)[-1] == 't')


def _empty(value):
    return value is None or value == ''


def _column_name(index):
    result = ''
    while index:
        index, digit = divmod(index - 1, 26)
        result = chr(65 + digit) + result
    return result


# Cells retain raw XML text and style; conversion happens only after schema match.
_BLANK = (None, 'text', 'General', None)
_BUILTIN_FORMATS = {0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
                    9: '0%', 10: '0.00%', 14: 'mm-dd-yy', 22: 'm/d/yy h:mm', 49: '@'}


def _read_csv(path):
    try:
        with open(path, encoding='utf-8-sig', newline='') as stream:
            records = list(csv.reader(stream, strict=True))
    except UnicodeDecodeError as exc:
        raise _SourceError('CSV_DECODE_FAILED', str(exc)) from exc
    rows = {r: [(v, 'text', 'General', None) for v in row] for r, row in enumerate(records, 1)}
    return rows, None, None, None, None, False


def _read_xlsx(path):
    with zipfile.ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = list(_child(workbook, 'sheets'))
        if len(sheets) > 1:
            raise _SourceError('UNSUPPORTED_MULTI_SHEET')
        if len(sheets) != 1:
            raise ValueError('Expected one worksheet')
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        sid = next(v for k, v in sheets[0].attrib.items() if k.endswith('}id'))
        matches = [r for r in rels if r.get('Id') == sid and r.get('Type', '').endswith('/worksheet')]
        if len(matches) != 1 or matches[0].get('TargetMode') == 'External':
            raise ValueError('Worksheet relationship unresolved')
        def part(target):
            name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
            if name.startswith('../'):
                raise ValueError('Invalid package part')
            return name
        worksheet = ET.fromstring(archive.read(part(matches[0].attrib['Target'])))
        styles = ['General']
        stylepart = next((part(r.attrib['Target']) for r in rels if r.get('Type', '').endswith('/styles')), 'xl/styles.xml')
        if stylepart in archive.namelist():
            root = ET.fromstring(archive.read(stylepart))
            formats = dict(_BUILTIN_FORMATS)
            custom = _child(root, 'numFmts')
            if custom is not None:
                formats.update({int(c.attrib['numFmtId']): c.attrib['formatCode'] for c in custom})
            xfs = _child(root, 'cellXfs')
            if xfs is not None:
                styles = [formats.get(int(x.get('numFmtId', '0')), 'unsupported:'+x.get('numFmtId', '0')) for x in xfs]
        stringpart = next((part(r.attrib['Target']) for r in rels if r.get('Type', '').endswith('/sharedStrings')), 'xl/sharedStrings.xml')
        strings = [_text(c) for c in ET.fromstring(archive.read(stringpart))] if stringpart in archive.namelist() else []
        currency = None
        if 'docProps/custom.xml' in archive.namelist():
            props = ET.fromstring(archive.read('docProps/custom.xml'))
            values = {p.get('name'): next(iter(p)).text if len(p) else None for p in props}
            if 'Currency' in values or 'CurrencySymbol' in values:
                currency = {'code': values.get('Currency'), 'symbol': values.get('CurrencySymbol')}
        rows, coordinates = {}, set()
        for c in worksheet.iter():
            if c.tag.rsplit('}', 1)[-1] != 'c':
                continue
            match = re.fullmatch(r'([A-Z]+)([1-9][0-9]*)', c.get('r', ''))
            if not match:
                raise ValueError('Invalid cell coordinate')
            col = 0
            for letter in match[1]:
                col = col * 26 + ord(letter) - 64
            row = int(match[2])
            if (row, col) in coordinates or col > 16384 or row > 1048576:
                raise ValueError('Duplicate or out-of-range cell')
            coordinates.add((row, col))
            cached = _child(c, 'v')
            raw = None if cached is None else cached.text
            kind, error = c.get('t', 'n'), None
            if _child(c, 'f') is not None and _empty(raw):
                error = 'FORMULA_CACHE_MISSING'
            if kind == 'inlineStr':
                raw = _text(_child(c, 'is'))
            elif kind == 's' and not _empty(raw):
                raw = strings[int(raw)]
            elif kind == 'b' and not _empty(raw):
                if raw not in ('0', '1'):
                    error = 'CELL_CONVERSION_FAILED'
                else:
                    raw = raw == '1'
            elif kind == 'e':
                error = 'CELL_CONVERSION_FAILED'
            elif kind not in ('n', 's', 'str', 'b', 'd'):
                error = 'CELL_CONVERSION_FAILED'
            style = styles[int(c.get('s', '0'))]
            line = rows.setdefault(row, [])
            line.extend([_BLANK] * (col - len(line)))
            line[col - 1] = (raw, kind, style, error)
        dimension = _child(worksheet, 'dimension')
        actual = None
        if coordinates:
            first = _column_name(min(c for r, c in coordinates)) + str(min(r for r, c in coordinates))
            last = _column_name(max(c for r, c in coordinates)) + str(max(r for r, c in coordinates))
            actual = first if first == last else first + ':' + last
        prop = _child(workbook, 'workbookPr')
        date1904 = prop is not None and prop.get('date1904', '').lower() in ('1', 'true')
        return rows, sheets[0].get('name'), None if dimension is None else dimension.get('ref'), actual, currency, date1904


def _validate_registry(registry):
    try:
        for schema in registry['schemas']:
            cols = schema['columns']
            if [c['index'] for c in cols] != list(range(1, len(cols) + 1)):
                raise ValueError('Source indices must be consecutive')
            names = []
            for c in cols:
                allowed = {'Text': {'text', 'mixed_display'}, 'Number': {'decimal', 'percentage', 'currency'},
                           'DateTime': {'date'}, 'Boolean': {'boolean'}}
                if c['parse'] not in allowed[c['field_type']]:
                    raise ValueError('Incompatible field type and parser')
                names.append(c['target_name'])
                if c['parse'] == 'percentage' and c.get('bare_percent_unit') not in ('ratio', 'points'):
                    raise ValueError('Missing percentage unit')
                source = c.get('currency_source')
                if c['parse'] == 'currency':
                    if not source or source['kind'] not in ('metadata', 'column'):
                        raise ValueError('Missing registered currency source')
                    if source['kind'] == 'column' and not 1 <= source['index'] <= len(cols):
                        raise ValueError('Invalid currency column')
                companion = c.get('numeric_companion')
                if companion:
                    if c['parse'] != 'mixed_display' or companion['field_type'] != 'Number' or companion['hidden'] is not True:
                        raise ValueError('Invalid companion definition')
                    names.append(companion['name'])
                elif c['parse'] == 'mixed_display':
                    raise ValueError('Missing registered companion')
            if len(set(names)) != len(names) or any(not isinstance(n, str) or not n for n in names):
                raise ValueError('Duplicate or empty target names')
            if not schema['header_rows'] or schema['data_start_row'] <= max(schema['header_rows']):
                raise ValueError('Invalid header/data boundary')
    except (KeyError, TypeError, ValueError) as exc:
        raise _SourceError('SCHEMA_INVALID', str(exc)) from exc


def _get(row, index):
    return row[index - 1] if index <= len(row) else _BLANK


def _headers(rows, schema):
    width = max((len(rows.get(r, [])) for r in schema['header_rows']), default=0)
    parts = [[str(_get(rows.get(r, []), i)[0]).strip() for r in schema['header_rows']
              if not _empty(_get(rows.get(r, []), i)[0])] for i in range(1, width + 1)]
    return ['：'.join(p for p in ps if p) for ps in parts]


def _plain(value):
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def _numeric(raw, percent=False, points=False, native_percent=False, currency=None):
    if isinstance(raw, bool):
        raise ValueError('Boolean is not Number')
    text = str(raw).strip()
    if not text or text in ('-', '--'):
        return None
    if currency is not None:
        match = re.match(r'^(PHP|USD|EUR|GBP|CNY|JPY|INR|[₱$€£¥₹])\s*', text)
        if match:
            marker = match[1]
            codes = {'₱': {'PHP'}, '$': {'USD'}, '€': {'EUR'}, '£': {'GBP'}, '¥': {'CNY', 'JPY'}, '₹': {'INR'}}
            if currency not in codes.get(marker, {marker}):
                raise _SourceError('CURRENCY_MISMATCH', 'Amount marker conflicts with currency source')
            text = text[match.end():]
    literal_percent = text.endswith('%')
    if literal_percent:
        if not percent:
            raise ValueError('Percentage literal in non-percentage field')
        text = text[:-1].strip()
    if not re.fullmatch(r'[+-]?(?:(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?', text):
        raise ValueError('Invalid decimal or thousands grouping')
    value = Decimal(text.replace(',', ''))
    if not value.is_finite():
        raise ValueError('Nonfinite number')
    if literal_percent or (points and not native_percent):
        # Adjust the exponent directly: never round through the Decimal context.
        sign, digits, exponent = value.as_tuple()
        value = Decimal((sign, digits, exponent - 2))
    if value == value.to_integral_value() and abs(value) > 9007199254740991:
        raise _SourceError('NUMBER_PRECISION_UNSUPPORTED', 'Integer exceeds 2**53-1')
    return value


def _date(raw, kind, date1904, offset):
    if isinstance(raw, bool):
        raise ValueError('Boolean is not DateTime')
    text = str(raw).strip()
    if not text or text in ('-', '--'):
        return None
    timezone = dt.timezone(dt.timedelta(minutes=offset))
    if kind == 'n':
        value = Decimal(text)
        if not value.is_finite() or (not date1904 and 60 <= value < 61):
            raise ValueError('Invalid Excel date serial')
        epoch = dt.datetime(1904, 1, 1, tzinfo=timezone) if date1904 else dt.datetime(1899, 12, 31, tzinfo=timezone)
        if not date1904 and value >= 61:
            value -= 1
        with localcontext() as ctx:
            ctx.prec = max(40, len(value.as_tuple().digits) + 15)
            milliseconds = int((value * 86400000).to_integral_value(rounding=ROUND_HALF_UP))
        instant = epoch + dt.timedelta(milliseconds=milliseconds)
    else:
        try:
            instant = dt.datetime.fromisoformat(text.replace('Z', '+00:00'))
        except ValueError:
            instant = dt.datetime.strptime(text, '%m/%d/%Y %I:%M:%S %p')
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone)
    delta = instant.astimezone(dt.timezone.utc) - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000


def _display(raw, kind, style, mixed=False):
    if kind != 'n':
        return str(raw)
    number = Decimal(raw)
    if not number.is_finite():
        raise ValueError('Nonfinite numeric text')
    if not mixed:
        if re.fullmatch('0+', style) and number == number.to_integral_value():
            return format(int(number), '0' + str(len(style)) + 'd')
        return _plain(number)
    if style in ('General', '@'):
        return _plain(number)
    match = re.fullmatch(r'0(?:\.(0+))?(%)?', style)
    if not match:
        raise _SourceError('SOURCE_FORMAT_UNSUPPORTED', 'Unsupported mixed numeric display: ' + style)
    places = len(match[1] or '')
    with localcontext() as ctx:
        ctx.prec = max(40, len(number.as_tuple().digits) + abs(number.as_tuple().exponent) + places + 4)
        if match[2]:
            number *= 100
        return format(number.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP), 'f') + ('%' if match[2] else '')


def _convert(cell, column, date1904, offset, currency):
    raw, kind, style, error = cell
    if error:
        raise _SourceError(error, 'Invalid saved cell result')
    if _empty(raw):
        return None
    parse = column['parse']
    if parse in ('text', 'mixed_display'):
        return _display(raw, kind, style, parse == 'mixed_display')
    if parse == 'date':
        return _date(raw, kind, date1904, offset)
    if parse == 'boolean':
        if isinstance(raw, bool):
            return raw
        value = str(raw).strip().lower()
        if not value:
            return None
        if value not in ('true', 'false', '1', '0'):
            raise ValueError('Unknown Boolean literal')
        return value in ('true', '1')
    return _numeric(raw, parse == 'percentage', column.get('bare_percent_unit') == 'points',
                    kind == 'n' and '%' in style, currency if parse == 'currency' else None)


def _currency(column, business, metadata):
    source = column['currency_source']
    if source['kind'] == 'column':
        codes = {str(_get(row, source['index'])[0]).strip().upper() for _, row in business
                 if not _empty(_get(row, source['index'])[0]) and str(_get(row, source['index'])[0]).strip()}
    else:
        code = (metadata or {}).get('code')
        codes = {str(code).strip().upper()} if code else set()
    if len(codes) > 1:
        raise _SourceError('CURRENCY_MISMATCH', 'Multiple currency codes in registered source')
    code = next(iter(codes), None)
    if code and not re.fullmatch('[A-Z]{3}', code):
        raise _SourceError('CURRENCY_MISMATCH', 'Invalid currency code')
    if source.get('expected_code') and code and code != source['expected_code']:
        raise _SourceError('CURRENCY_MISMATCH', 'Currency differs from registered expected code')
    if source['kind'] == 'metadata' and metadata and metadata.get('symbol'):
        symbols = {'₱': {'PHP'}, '$': {'USD'}, '€': {'EUR'}, '£': {'GBP'}, '¥': {'CNY', 'JPY'}, '₹': {'INR'}}
        if code and code not in symbols.get(metadata['symbol'], {metadata['symbol']}):
            raise _SourceError('CURRENCY_MISMATCH', 'Metadata symbol conflicts with code')
    if not code:
        for rownum, row in business:
            raw = _get(row, column['index'])[0]
            if raw is not None and str(raw).strip() not in ('', '-', '--'):
                raise _SourceError('CURRENCY_MISSING', 'Amount has no registered currency evidence', source_row=rownum, raw_value=raw)
    return code


def read_source(file_meta, *, registry=None):
    """Return a complete typed baseline or one contextual error, never partial data."""
    context = {'relative_path': file_meta.get('relative_path')}
    try:
        registry = load_schema_registry() if registry is None else registry
        _validate_registry(registry)
        relative = PurePosixPath(file_meta['relative_path'].replace('\\', '/'))
        extension = file_meta['extension'].lower()
        candidates = [s for s in registry['schemas'] if s['match']['directory'] == str(relative.parent)
                      and (s['match'].get('stem') is None or s['match']['stem'] == relative.stem)
                      and extension in [e.lower() for e in s['match']['extensions']]]
        if not candidates:
            raise _SourceError('SCHEMA_NOT_FOUND')
        if extension not in ('.xlsx', '.csv'):
            raise _SourceError('UNSUPPORTED_EXTENSION')
        parsed = (_read_csv if extension == '.csv' else _read_xlsx)(file_meta['absolute_path'])
        rows, sheet, declared, actual, metadata, date1904 = parsed
        matches = [s for s in candidates if _headers(rows, s) == [c['source_name'] for c in s['columns']]]
        if not matches:
            raise _SourceError('SCHEMA_MISMATCH', 'Complete header names/order differ from registered candidates')
        if len(matches) != 1:
            raise _SourceError('SCHEMA_AMBIGUOUS')
        schema = matches[0]
        context['schema_key'] = schema['schema_key']
        columns = schema['columns']
        width = len(columns)
        business = []
        for r, row in sorted(rows.items()):
            if r < schema['data_start_row']:
                continue
            if any(not _empty(c[0]) or c[3] for c in row[width:]):
                raise _SourceError('SCHEMA_MISMATCH', 'Business value outside registered columns', source_row=r)
            if any(not _empty(c[0]) or c[3] for c in row):
                business.append((r, row))
        currencies = {}
        fields, companions = [], []
        for c in columns:
            context.update(source_index=c['index'], source_name=c['source_name'])
            fmt = deepcopy(c['format'])
            if c['parse'] == 'currency':
                currencies[c['index']] = _currency(c, business, metadata)
                fmt['currency'] = currencies[c['index']]
            key = 'c%03d' % c['index']
            fields.append(dict(field_key=key, source_index=c['index'], field_name=c['target_name'],
                               field_type=c['field_type'], format=fmt, hidden=False, derived=False))
            if c.get('numeric_companion'):
                partner = c['numeric_companion']
                companions.append(dict(field_key=key+'_numeric', source_index=c['index'], field_name=partner['name'],
                                       field_type='Number', format=deepcopy(partner['format']), hidden=True, derived=True))
        fields.extend(companions)
        records = []
        for rownum, row in business:
            values, extra = [], []
            for c in columns:
                cell = _get(row, c['index'])
                context.update(source_row=rownum, source_index=c['index'], source_name=c['source_name'], raw_value=cell[0])
                values.append(_convert(cell, c, date1904, registry['utc_offset_minutes'], currencies.get(c['index'])))
                if c.get('numeric_companion'):
                    extra.append(None if _empty(cell[0]) else _numeric(cell[0], percent=True))
            records.append(dict(source_row=rownum, row_key='row_%06d' % (len(records)+1), values=values+extra))
        baseline = {k: file_meta[k] for k in ('absolute_path', 'relative_path', 'file_hash')}
        baseline.update(extension=extension, sheet_name=sheet, declared_dimension=declared, actual_used_range=actual,
                        header_rows=list(schema['header_rows']), data_start_row=schema['data_start_row'], column_count=width,
                        effective_record_count=len(records), columns=[dict(index=c['index'], preferred_name=c['source_name'],
                        semantic_parts=c['source_name'].split('：'), has_business_name=True) for c in columns],
                        source_records=records, currency_metadata=deepcopy(metadata), write_mode='typed_schema_v1',
                        schema_key=schema['schema_key'], schema_version=registry['version'], target_field_count=len(fields),
                        target_fields=fields, visible_field_keys=[f['field_key'] for f in fields if not f['hidden']])
        return {'status': 'OK', 'baseline': baseline, 'errors': []}
    except _SourceError as exc:
        return {'status': 'ERROR', 'baseline': None, 'errors': [dict(context, **{'error': exc.code, 'detail': str(exc)}, **exc.context)]}
    except (OSError, ValueError, KeyError, TypeError, IndexError, InvalidOperation, OverflowError, csv.Error, zipfile.BadZipFile, ET.ParseError) as exc:
        return {'status': 'ERROR', 'baseline': None, 'errors': [dict(context, error='CELL_CONVERSION_FAILED', detail=str(exc))]}
