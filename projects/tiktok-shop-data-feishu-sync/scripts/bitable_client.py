"""Small application-identity OpenAPI adapter; no retries or file orchestration."""
from copy import deepcopy
from decimal import Decimal
import json
import os
import re
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode

HOST = 'https://open.feishu.cn'
AUTH = '/open-apis/auth/v3/tenant_access_token/internal'


class BitableClientError(Exception):
    def __init__(self, code, detail, operation='', *, context=None, http_status=None,
                 api_code=None, request_id=None, raw_error=None):
        self.code, self.detail, self.operation = code, detail, operation
        self.context = deepcopy(context or {})
        self.http_status, self.api_code, self.request_id = http_status, api_code, request_id
        self.raw_error = deepcopy(raw_error)
        super().__init__(f'{code}: {detail}')


def _require(ok, detail, code='INVALID_INPUT'):
    if not ok:
        raise BitableClientError(code, detail)


def _id(value):
    _require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]+', value), 'Invalid resource ID')
    return quote(value, safe='')


def _name(value, limit=None):
    _require(isinstance(value, str) and bool(value) and (limit is None or len(value) <= limit), 'Invalid or overlong name')
    return value


def _ids(values, nonempty=False):
    _require(isinstance(values, list) and (not nonempty or bool(values)), 'Expected ID list')
    for value in values:
        _id(value)
    _require(len(set(values)) == len(values), 'Duplicate IDs')
    return values


def _object(value):
    _require(isinstance(value, dict), 'Expected response object', 'INVALID_RESPONSE')
    return value


def _string(obj, key):
    value = _object(obj).get(key)
    _require(isinstance(value, str) and bool(value), 'Missing response identity/name: '+key, 'INVALID_RESPONSE')
    return value


def _json(value):
    """Encode each JSON token separately, preserving Decimal without float conversion."""
    if value is None:
        return 'null'
    if type(value) is bool:
        return 'true' if value else 'false'
    if type(value) is int:
        return str(value)
    if isinstance(value, Decimal):
        _require(value.is_finite(), 'Nonfinite Decimal')
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '['+','.join(_json(v) for v in value)+']'
    if isinstance(value, dict):
        _require(all(isinstance(k, str) for k in value), 'JSON object keys must be strings')
        return '{'+','.join(_json(k)+':'+_json(v) for k,v in value.items())+'}'
    raise BitableClientError('INVALID_INPUT', 'Unsupported JSON value; floats are not accepted')


def _pairs(pairs):
    out = {}
    for k,v in pairs:
        if k in out:
            raise ValueError('Duplicate JSON key')
        out[k] = v
    return out


def _constant(value):
    raise ValueError('Nonfinite JSON constant')


def build_field_definition(target_field):
    """Adapt a typed declaration to v1, reporting only actual display changes."""
    _require(isinstance(target_field, dict), 'Expected field declaration')
    name = _name(target_field.get('field_name'))
    typ, fmt = target_field.get('field_type'), target_field.get('format')
    _require(typ in ('Text','Number','DateTime','Boolean') and isinstance(fmt,dict), 'Invalid field type/format')
    d = {'field_name':name, 'type':{'Text':1,'Number':2,'DateTime':5,'Boolean':7}[typ]}
    changes = []
    kind, pattern = fmt.get('kind'), fmt.get('pattern')
    def adjustment(requested, applied, reason):
        changes.append({'field_name':name,'requested':requested,'applied':applied,'values_unchanged':True,'reason':reason})
    if typ == 'Text':
        _require(kind == 'text', 'Invalid Text format')
    elif typ == 'Boolean':
        _require(kind == 'boolean', 'Invalid Boolean format')
    elif typ == 'DateTime':
        _require(kind in ('date','datetime'), 'Invalid DateTime format')
        _require(pattern in ('yyyy-MM-dd','yyyy-MM-dd HH:mm','yyyy-MM-dd HH:mm:ss'), 'Unsupported date format')
        applied = 'yyyy-MM-dd' if kind == 'date' else 'yyyy-MM-dd HH:mm'
        d['property'] = {'date_formatter':applied, 'auto_fill':False}
        if pattern != applied:
            adjustment(pattern, applied, 'Display to minutes; original milliseconds are unchanged')
    else:
        _require(kind in ('number','currency','percentage'), 'Invalid Number format')
        prop = {}
        if kind == 'percentage':
            _require(pattern == '0.00%', 'Unsupported percentage formatter')
            prop['formatter'] = pattern
        else:
            if pattern == 'General':
                adjustment('General', 'server_default', 'Server default is not an Excel General rendering engine')
            else:
                _require(isinstance(pattern,str) and re.fullmatch(r'0(?:\.0{1,4})?',pattern), 'Unsupported number formatter')
                prop['formatter'] = pattern
            if kind == 'currency':
                currency = fmt.get('currency')
                if currency is None:
                    adjustment('currency=None', 'Number', 'Currency unspecified for empty amounts; no default currency assigned')
                else:
                    _require(isinstance(currency,str) and re.fullmatch('[A-Z]{3}',currency), 'Invalid currency code')
                    d['ui_type'] = 'Currency'
                    prop['currency_code'] = currency
        if prop:
            d['property'] = prop
    return {'definition':d,'display_adjustments':changes}


def _definition(value):
    _require(isinstance(value,dict), 'Expected native field definition')
    _name(value.get('field_name'))
    _require(type(value.get('type')) is int and value['type'] in (1,2,5,7,20), 'Unsupported native field type')
    _require(set(value) <= {'field_name','type','ui_type','property','description'}, 'Non-v1 field properties')
    if 'property' in value:
        _require(isinstance(value['property'],dict), 'Invalid field property')
    _json(value)
    return deepcopy(value)


def _transport(method, url, headers, body, timeout_seconds):
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return {'status':response.status,'headers':dict(response.headers),'body':response.read()}
    except urllib.error.HTTPError as exc:
        return {'status':exc.code,'headers':dict(exc.headers),'body':exc.read()}


class BitableClient:
    def __init__(self, *, app_id=None, app_secret=None, transport=None, clock=None,
                 timeout_seconds=60, page_size=100):
        _require(type(page_size) is int and page_size > 0, 'Invalid page size')
        _require(isinstance(timeout_seconds,(int,float)) and timeout_seconds > 0, 'Invalid timeout')
        self.app_id = app_id if app_id is not None else os.environ.get('FEISHU_APP_ID')
        self._secret = app_secret if app_secret is not None else os.environ.get('FEISHU_APP_SECRET')
        self._transport = transport if transport is not None else _transport
        self._clock = clock if clock is not None else time.monotonic
        self.timeout_seconds, self.page_size = timeout_seconds, page_size
        self._token, self._expires = None, 0
        self._secrets = [x for x in (self._secret,) if isinstance(x,str) and x]

    def _scrub(self, value):
        if isinstance(value, dict):
            return {k:('[REDACTED]' if k.lower() in ('authorization','app_secret','tenant_access_token','user_access_token','app_access_token','refresh_token','cookie') else self._scrub(v)) for k,v in value.items()}
        if isinstance(value, list):
            return [self._scrub(v) for v in value]
        if isinstance(value,str):
            for secret in self._secrets:
                value = value.replace(secret,'[REDACTED]')
        return value

    def _request(self, method, path, body=None, query=None, auth=False):
        operation = method+' '+path
        encoded = None if body is None else _json(body).encode('utf-8')
        headers = {'Content-Type':'application/json; charset=utf-8'}
        if not auth:
            self._authenticate()
            headers['Authorization'] = 'Bearer '+self._token
        url = HOST+path+('?' + urlencode(query) if query else '')
        try:
            result = self._transport(method,url,headers,encoded,self.timeout_seconds)
        except Exception as exc:
            raise BitableClientError('TRANSPORT_ERROR',self._scrub(str(exc)),operation,
                                     context={'result_state':'unknown'}) from None
        status, rid, obj = None, None, None
        try:
            status = result['status']
            rid = next((v for k,v in result['headers'].items() if k.lower() in ('x-tt-logid','x-request-id')),None)
            obj = json.loads(result['body'].decode('utf-8-sig'),parse_float=Decimal,parse_constant=_constant,object_pairs_hook=_pairs)
            if isinstance(obj,dict):
                for key in ('tenant_access_token','user_access_token','app_access_token','refresh_token'):
                    if isinstance(obj.get(key),str) and obj[key]:
                        self._secrets.append(obj[key])
            _require(isinstance(obj,dict) and type(obj.get('code')) is int,'Missing/invalid business code','INVALID_RESPONSE')
            if not (type(status) is int and 200 <= status < 300) or obj['code'] != 0:
                raise BitableClientError('AUTH_ERROR' if auth else 'API_ERROR',self._scrub(str(obj.get('msg','HTTP/API failure'))),operation,
                    http_status=status,api_code=obj['code'],request_id=rid,raw_error=self._scrub(obj),context={'result_state':'failed'})
            if auth:
                return obj
            _require('data' in obj,'Missing response data','INVALID_RESPONSE')
            return obj['data']
        except BitableClientError as exc:
            if exc.operation:
                raise
            raise BitableClientError(exc.code,self._scrub(exc.detail),operation,http_status=status,
                api_code=obj.get('code') if isinstance(obj,dict) else None,request_id=rid,raw_error=self._scrub(obj),context={'result_state':'unknown'}) from None
        except (ValueError,KeyError,TypeError,AttributeError) as exc:
            raise BitableClientError('INVALID_RESPONSE',self._scrub(str(exc)),operation,http_status=status,
                request_id=rid,raw_error=self._scrub(obj),context={'result_state':'unknown'}) from None

    def _authenticate(self):
        if self._token and self._clock() < self._expires-60:
            return
        _require(isinstance(self.app_id,str) and bool(self.app_id) and isinstance(self._secret,str) and bool(self._secret),'Missing application credentials','AUTH_ERROR')
        started = self._clock()
        obj = self._request('POST',AUTH,{'app_id':self.app_id,'app_secret':self._secret},auth=True)
        token, expire = obj.get('tenant_access_token'),obj.get('expire')
        _require(isinstance(token,str) and bool(token) and type(expire) is int and expire>0,'Invalid authentication response','AUTH_ERROR')
        self._token, self._expires = token, started+expire

    @staticmethod
    def _base(base):
        return '/open-apis/bitable/v1/apps/'+_id(base)

    def _table(self,base,table):
        return self._base(base)+'/tables/'+_id(table)

    @staticmethod
    def _v3(base):
        return '/open-apis/base/v3/bases/'+_id(base)

    def _pages(self,path,key='items',identity=None,query=None):
        params = dict(query or {},page_size=self.page_size)
        items, seen, cursors = [], set(), set()
        total = None
        while True:
            data = _object(self._request('GET',path,query=params))
            page = data.get(key)
            # v1 omits items for an explicitly confirmed empty result.
            if key not in data and type(data.get('total')) is int and data['total'] == 0 and data.get('has_more') is False:
                page = []
            _require(isinstance(page,list) and type(data.get('has_more')) is bool,'Incomplete paginated response','INVALID_RESPONSE')
            if 'total' in data:
                _require(type(data['total']) is int and data['total'] >= 0,'Invalid total','INVALID_RESPONSE')
                if total is not None:
                    _require(total == data['total'],'Total changed during pagination','INVALID_RESPONSE')
                total = data['total']
            for item in page:
                _object(item)
                if identity:
                    value = _string(item,identity)
                    _require(value not in seen,'Duplicate response ID','INVALID_RESPONSE')
                    seen.add(value)
                items.append(item)
            if not data['has_more']:
                break
            cursor = data.get('page_token')
            _require(isinstance(cursor,str) and bool(cursor) and cursor not in cursors,'Missing/repeated pagination cursor','INVALID_RESPONSE')
            cursors.add(cursor)
            params['page_token'] = cursor
        if total is not None:
            _require(len(items)==total,'Incomplete total','INVALID_RESPONSE')
        return items

    def get_root_folder_token(self):
        return _string(self._request('GET','/open-apis/drive/explorer/v2/root_folder/meta'),'token')

    def list_drive_children(self,folder_token):
        _id(folder_token)
        return [dict(token=_string(x,'token'),name=_string(x,'name'),type=_string(x,'type'),raw=deepcopy(x))
                for x in self._pages('/open-apis/drive/v1/files','files','token',{'folder_token':folder_token})]

    def create_drive_folder(self,parent_folder_token,folder_name):
        _id(parent_folder_token);_name(folder_name)
        data = self._request('POST','/open-apis/drive/v1/files/create_folder',{'folder_token':parent_folder_token,'name':folder_name})
        return {'folder_token':_string(data,'token'),'folder_name':folder_name,'raw':deepcopy(data)}

    def resolve_parent_folder(self,parent_folder_path,create_missing=False):
        _require(isinstance(parent_folder_path,str) and parent_folder_path.startswith('/'),'Expected absolute cloud folder path')
        parent = self.get_root_folder_token()
        for name in self._parts(parent_folder_path):
            matches = [x for x in self.list_drive_children(parent) if x['name']==name and x['type']=='folder']
            _require(len(matches)<=1,'Ambiguous cloud folder','AMBIGUOUS')
            if not matches:
                _require(create_missing,'Cloud folder not found','NOT_FOUND')
                parent = self.create_drive_folder(parent,name)['folder_token']
            else:
                parent = matches[0]['token']
        return {'folder_token':parent,'folder_path':parent_folder_path}

    def find_base_by_name(self,parent_folder_token,expected_base_name):
        _name(expected_base_name)
        matches = [x for x in self.list_drive_children(parent_folder_token) if x['type']=='bitable' and x['name']==expected_base_name]
        _require(len(matches)<=1,'Ambiguous Base name','AMBIGUOUS')
        return None if not matches else {'base_token':matches[0]['token'],'base_name':matches[0]['name'],'raw':matches[0]['raw']}

    def get_base(self,base_token):
        data = _object(self._request('GET',self._base(base_token)))
        app = _object(data.get('app'))
        _require(_string(app,'app_token')==base_token,'Base ID mismatch','INVALID_RESPONSE')
        return dict(base_token=base_token,base_name=_string(app,'name'),time_zone=app.get('time_zone'),raw=deepcopy(app))

    def create_base(self,parent_folder_token,base_name):
        _id(parent_folder_token);_name(base_name)
        data = _object(self._request('POST','/open-apis/bitable/v1/apps',{'name':base_name,'folder_token':parent_folder_token,'time_zone':'Asia/Shanghai'}))
        app = _object(data.get('app'))
        _require(_string(app,'name')==base_name,'Created Base name mismatch','INVALID_RESPONSE')
        return dict(base_token=_string(app,'app_token'),base_name=base_name,default_table_id=app.get('default_table_id'),raw=deepcopy(app))

    def list_tables(self,base_token):
        tables = [dict(table_id=_string(x,'table_id'),table_name=_string(x,'name'),raw=deepcopy(x))
                  for x in self._pages(self._base(base_token)+'/tables',identity='table_id')]
        return {'tables':tables,'table_count':len(tables)}

    def get_table(self,base_token,table_id):
        _id(table_id)
        matches = [x for x in self.list_tables(base_token)['tables'] if x['table_id']==table_id]
        _require(len(matches)==1,'Table not found','NOT_FOUND')
        return matches[0]

    def create_table(self,base_token,table_name,field_definitions,default_view_name='数据'):
        _name(table_name,100);_name(default_view_name)
        _require(isinstance(field_definitions,list) and bool(field_definitions),'Expected field definitions')
        defs = [_definition(x) for x in field_definitions]
        _require(len({x['field_name'] for x in defs})==len(defs),'Duplicate field names')
        data = _object(self._request('POST',self._base(base_token)+'/tables',{'table':{'name':table_name,'default_view_name':default_view_name,'fields':defs}}))
        tid = _string(data,'table_id')
        view = _string(data,'default_view_id')
        ids = data.get('field_id_list')
        _ids(ids,True)
        _require(len(ids)==len(defs),'Incomplete created field IDs','INVALID_RESPONSE')
        return dict(table_id=tid,default_view_id=view,field_id_list=list(ids),raw=deepcopy(data))

    def rename_table(self,base_token,table_id,new_name):
        _name(new_name,100)
        data = _object(self._request('POST',self._v3(base_token)+'/blocks/'+_id(table_id)+'/rename',{'name':new_name}))
        _require(_string(data,'id')==table_id and data.get('name')==new_name,'Rename identity mismatch','INVALID_RESPONSE')
        return data

    def delete_table(self,base_token,table_id):
        data = _object(self._request('DELETE',self._table(base_token,table_id)))
        _require(data.get('table_id',table_id)==table_id and data.get('deleted',True) is True,'Table deletion not confirmed','INVALID_RESPONSE')
        return data

    @staticmethod
    def _field(item):
        fid, name = _string(item,'field_id'),_string(item,'field_name')
        _require(type(item.get('type')) is int,'Invalid native field type','INVALID_RESPONSE')
        return dict(deepcopy(item),field_id=fid,field_name=name,raw=deepcopy(item))

    def list_fields(self,base_token,table_id):
        return [self._field(x) for x in self._pages(self._table(base_token,table_id)+'/fields',identity='field_id')]

    def create_field(self,base_token,table_id,field_definition):
        definition = _definition(field_definition)
        data = _object(self._request('POST',self._table(base_token,table_id)+'/fields',definition))
        result = self._field(data.get('field'))
        _require(result['field_name']==definition['field_name'] and result['type']==definition['type'],'Created field differs','INVALID_RESPONSE')
        return result

    def update_field(self,base_token,table_id,field_id,field_definition):
        definition = _definition(field_definition)
        data = _object(self._request('PUT',self._table(base_token,table_id)+'/fields/'+_id(field_id),definition))
        result = self._field(data.get('field'))
        _require(result['field_id']==field_id and result['field_name']==definition['field_name'] and result['type']==definition['type'],'Updated field differs','INVALID_RESPONSE')
        return result

    def list_blocks(self,base_token,parent_id=None):
        body = {} if parent_id is None else {'parent_id':_id(parent_id)}
        data = _object(self._request('POST',self._v3(base_token)+'/blocks/list',body))
        blocks = data.get('blocks')
        _require(isinstance(blocks,list) and type(data.get('total')) is int and len(blocks)==data['total'],'Incomplete blocks','INVALID_RESPONSE')
        result = [dict(block_id=_string(x,'id'),block_type=_string(x,'type'),name=_string(x,'name'),parent_id=x.get('parent_id'),raw=deepcopy(x)) for x in blocks]
        _require(len({x['block_id'] for x in result})==len(result),'Duplicate block IDs','INVALID_RESPONSE')
        return result

    def create_folder(self,base_token,folder_name,parent_id=None):
        body = {'type':'folder','name':_name(folder_name)}
        if parent_id is not None:
            body['parent_id'] = _id(parent_id)
        data = _object(self._request('POST',self._v3(base_token)+'/blocks',body))
        _require(data.get('type')=='folder' and data.get('name')==folder_name and data.get('parent_id')==parent_id,'Created folder differs','INVALID_RESPONSE')
        return dict(folder_id=_string(data,'id'),folder_name=folder_name,parent_id=parent_id,raw=deepcopy(data))

    @staticmethod
    def _parts(path):
        _require(isinstance(path,str),'Expected folder path')
        parts = [x for x in path.split('/') if x]
        _require(all(x not in ('.','..') for x in parts),'Relative traversal is not a folder name')
        return parts

    def resolve_folder_path(self,base_token,folder_path,create_missing=False):
        parts = self._parts(folder_path)
        parent = None
        blocks = self.list_blocks(base_token) if parts else []
        for name in parts:
            matches = [x for x in blocks if x['name']==name and x['block_type']=='folder' and x['parent_id']==parent]
            _require(len(matches)<=1,'Ambiguous internal folder','AMBIGUOUS')
            if matches:
                parent = matches[0]['block_id']
            else:
                _require(create_missing,'Internal folder not found','NOT_FOUND')
                parent = self.create_folder(base_token,name,parent)['folder_id']
        return {'folder_id':parent,'folder_path':folder_path}

    def move_table(self,base_token,table_id,parent_folder_id=None):
        if parent_folder_id is not None:
            _id(parent_folder_id)
        data = _object(self._request('POST',self._v3(base_token)+'/blocks/'+_id(table_id)+'/move',{'parent_id':parent_folder_id}))
        _require(_string(data,'id')==table_id and data.get('parent_id')==parent_folder_id,'Moved table identity differs','INVALID_RESPONSE')
        return data

    def _field_map(self,base,table):
        fields = self.list_fields(base,table)
        _require(len({f['field_name'] for f in fields})==len(fields),'Duplicate remote field names','INVALID_RESPONSE')
        return {f['field_id']:f for f in fields}

    @staticmethod
    def _value(value,typ):
        allowed = {1:(str,),2:(Decimal,int),5:(int,),7:(bool,)}
        _require(typ in allowed,'Writing computed/unsupported fields is forbidden')
        if value is not None:
            _require(type(value) in allowed[typ],'Value does not match native field type')
            if isinstance(value,Decimal):
                _require(value.is_finite(),'Nonfinite Number')
        return value

    def batch_create_records(self,base_token,table_id,records):
        _require(isinstance(records,list),'Expected records list')
        if not records:
            return {'created_count':0,'record_ids':[]}
        fields = self._field_map(base_token,table_id)
        payload = []
        for row in records:
            _require(isinstance(row,dict) and set(row)=={'fields'} and isinstance(row['fields'],dict),'Invalid record structure')
            converted = {}
            for fid,value in row['fields'].items():
                _require(fid in fields,'Unknown field ID')
                f = fields[fid]
                converted[f['field_name']] = self._value(value,f['type'])
            payload.append({'fields':converted})
        # Pre-encode all values before the first write, including text encoding errors.
        _json(payload).encode('utf-8')
        return self._batches(base_token,table_id,payload,False)

    def batch_delete_records(self,base_token,table_id,record_ids):
        _ids(record_ids)
        if not record_ids:
            return {'deleted_count':0,'record_ids':[]}
        return self._batches(base_token,table_id,record_ids,True)

    def _batches(self,base,table,values,deleting):
        confirmed, completed = [], 0
        path = self._table(base,table)+'/records/'+('batch_delete' if deleting else 'batch_create')
        for start in range(0,len(values),200):
            batch = values[start:start+200]
            try:
                data = _object(self._request('POST',path,{'records':batch}))
                rows = data.get('records')
                _require(isinstance(rows,list) and len(rows)==len(batch) and not data.get('ignored_fields'),'Incomplete batch response','INVALID_RESPONSE')
                ids = [_string(row,'record_id') for row in rows]
                _require(len(set(ids))==len(ids) and not set(ids).intersection(confirmed),'Duplicate batch result IDs','INVALID_RESPONSE')
                _require(not any(row.get('ignored_fields') for row in rows),'Ignored record fields','INVALID_RESPONSE')
                if deleting:
                    _require(set(ids)==set(batch) and all(row.get('deleted') is True for row in rows),'Deletion not confirmed','INVALID_RESPONSE')
                confirmed.extend(ids)
                completed += 1
            except BitableClientError as exc:
                exc.context.update(completed_batches=completed,confirmed_record_ids=list(confirmed),submitted_batch_size=len(batch))
                exc.context.setdefault('result_state','unknown')
                if not exc.operation:
                    exc.operation = 'POST '+path
                    exc.raw_error = self._scrub(locals().get('data'))
                raise
        return {('deleted_count' if deleting else 'created_count'):len(confirmed),'record_ids':confirmed}

    def _projection(self,base,table,selected):
        _ids(selected,True)
        fields = self._field_map(base,table)
        _require(all(fid in fields for fid in selected),'Unknown selected field ID')
        return {fid:fields[fid]['field_name'] for fid in selected}

    @staticmethod
    def _record(row,projection,expected=None):
        rid = _string(row,'record_id')
        _require(expected is None or rid==expected,'Record ID mismatch','INVALID_RESPONSE')
        fields = row.get('fields')
        _require(isinstance(fields,dict),'Missing record fields object','INVALID_RESPONSE')
        return {'record_id':rid,'fields':{fid:deepcopy(fields.get(name)) for fid,name in projection.items()}}

    def list_records(self,base_token,table_id,selected_fields):
        projection = self._projection(base_token,table_id,selected_fields)
        rows = self._pages(self._table(base_token,table_id)+'/records',identity='record_id',query={'field_names':_json(list(projection.values()))})
        return [self._record(row,projection) for row in rows]

    def get_record(self,base_token,table_id,record_id,selected_fields):
        projection = self._projection(base_token,table_id,selected_fields)
        data = _object(self._request('GET',self._table(base_token,table_id)+'/records/'+_id(record_id)))
        return self._record(data.get('record'),projection,record_id)

    def list_views(self,base_token,table_id):
        result = []
        for item in self._pages(self._table(base_token,table_id)+'/views',identity='view_id'):
            result.append(dict(deepcopy(item),view_id=_string(item,'view_id'),type=_string(item,'view_type'),raw=deepcopy(item)))
        return result

    def _view_path(self,base,table,view):
        return self._v3(base)+'/tables/'+_id(table)+'/views/'+_id(view)+'/visible_fields'

    @staticmethod
    def _visible(data, fields):
        values = data.get('visible_fields') if isinstance(data, dict) else data
        _require(isinstance(values, list) and all(isinstance(v, str) for v in values),
                 'Invalid visible_fields response', 'INVALID_RESPONSE')
        by_id = {f['field_id']: f for f in fields}
        by_name = {}
        for field in fields:
            name = field['field_name']
            _require(name not in by_name, 'Duplicate remote field names', 'INVALID_RESPONSE')
            by_name[name] = field['field_id']
        result = []
        for value in values:
            identities = set()
            if value in by_id:
                identities.add(value)
            if value in by_name:
                identities.add(by_name[value])
            _require(len(identities) == 1, 'Unknown or ambiguous visible field identity', 'INVALID_RESPONSE')
            result.append(identities.pop())
        _require(len(set(result)) == len(result), 'Duplicate visible field identity', 'INVALID_RESPONSE')
        return result

    def get_visible_fields(self,base_token,table_id,view_id):
        fields = self.list_fields(base_token, table_id)
        data = self._request('GET', self._view_path(base_token, table_id, view_id))
        return self._visible(data, fields)

    def set_visible_fields(self,base_token,table_id,view_id,field_ids):
        _ids(field_ids,True)
        fields = self.list_fields(base_token, table_id)
        known = {f['field_id'] for f in fields}
        _require(all(fid in known for fid in field_ids), 'Unknown requested visible field ID')
        _require(len({f['field_name'] for f in fields}) == len(fields),
                 'Duplicate remote field names', 'INVALID_RESPONSE')
        data = self._request('PUT', self._view_path(base_token,table_id,view_id), {'visible_fields':field_ids})
        result = self._visible(data, fields)
        _require(result==field_ids,'Visible field order differs','INVALID_RESPONSE')
        return result
