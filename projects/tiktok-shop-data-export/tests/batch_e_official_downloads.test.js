'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { writeCsv } = require('../scripts/common/csv');
const { sha256File } = require('../scripts/common/file-check');
const { publishGeneratedCsv } = require('../scripts/common/output-publish');
const { countCsvDataRows } = require('../scripts/common/official_download_rows');
const { writeWorkbook } = require('../scripts/common/xlsx_writer');
const { publishMultiRunnerOutput } = require('../scripts/export');
const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');

const ROOT = path.resolve(__dirname, '..');
const IDS = [
  'product_analytics_performance', 'manage_orders_csv',
  'gmvmax_campaign_overview', 'gmvmax_campaign_product_creative_performance',
];
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runner(id) {
  const spec = loadReportMd().specs[id];
  return require(path.join(ROOT, spec.providers.cross_border.runner));
}

function put(target, parts, value) { let current=target; for(const part of parts.slice(0,-1)){current[part]??={};current=current[part];} current[parts.at(-1)]=value; }
function pagedBody(rules, rows, identity = {}) { const body={code:0,...identity}; const page={ [rules.response_paths.total]:rows.length,[rules.response_paths.page_count]:rows.length?1:0,[rules.response_paths.page]:1 }; put(body,rules.response_paths.table,rows); put(body,rules.response_paths.pagination,page); return body; }
function mockResponse(url, body, headers = {'content-type':'application/json'}) { const buffer=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)); return {url:()=>url,status:()=>200,headers:()=>headers,body:async()=>buffer}; }

test('real router exposes the four enabled Batch E reports without all/default', () => {
  const loaded = loadReportMd();
  assert.equal(Object.keys(loaded.specs).length, 23);
  for (const id of IDS) {
    assert.deepEqual(resolveReportIds(`report:${id}`, loaded), [id]);
    assert.equal(runner(id).validateSpec(loaded.specs[id], loaded.specs[id].providers?.cross_border), loaded.specs[id]);
  }
  assert.equal(loaded.specs.product_analytics_performance.providers.cross_border.runner, 'scripts/routes/cross_border/product_analytics_performance.js');
  for (const alias of ['all', 'default']) assert.throws(() => resolveReportIds(alias, loaded), { code: 'report_alias_unknown' });
});

test('dedicated validators reject unknown or contradictory report contracts', () => {
  const loaded = loadReportMd();
  for (const id of IDS) {
    const spec = structuredClone(loaded.specs[id]); spec.unknown = true;
    assert.equal(runner(id).validateSpec(spec, spec.providers.cross_border, { skillRoot:ROOT }), spec);
  }
  const creative = structuredClone(loaded.specs.gmvmax_campaign_product_creative_performance);
  creative.required_key_columns = ['Post ID', 'Post ID'];
  assert.throws(() => runner('gmvmax_campaign_product_creative_performance').validateSpec(creative, creative.providers.cross_border, {skillRoot:ROOT}), { code: 'creative_performance_report_spec_invalid' });
  for (const providers of [{ cross_border:{ origin:'https://example.com' } }, { cross_border:{}, local:{} }]) {
    const product = structuredClone(loaded.specs.product_analytics_performance); product.providers = providers;
    assert.throws(() => runner('product_analytics_performance').validateSpec(product, product.providers?.cross_border), { code:'product_analytics_report_spec_invalid' });
  }
});

test('Product Analytics uses frozen Seller origin plus MD entry path and rejects missing provider before page I/O', async (t) => {
  const root=temporary(t); const module=runner('product_analytics_performance');
  const spec=structuredClone(loadReportMd().specs.product_analytics_performance); const provider=spec.providers.cross_border; const rules=provider.official_validation; rules.entry_path='/sentinel-product-analytics';
  provider.audit_metadata=true; rules.audit_metadata='ignored'; spec.audit_metadata={owner:'architecture'};
  assert.equal(module.validateSpec(spec, provider, { skillRoot:ROOT }), spec);
  const missing=structuredClone(spec); delete missing.providers.cross_border.official_validation.list_endpoint;
  assert.throws(() => module.validateSpec(missing, missing.providers.cross_border, { skillRoot:ROOT }), { code:'product_analytics_report_spec_invalid' });
  const sellerUrl='https://seller.tiktokshopglobalselling.com/home'; const gotos=[]; let waits=0;
  const responseUrl=new URL(rules.list_endpoint,provider.response_origin); responseUrl.searchParams.set(rules.seller_query,'88001');
  const body={code:0,data:{list_control:{next_pagination:{total:0}}}};
  const response={url:()=>responseUrl.href,status:()=>200,json:async()=>body};
  const page={url:()=>sellerUrl,waitForResponse:async(predicate)=>{waits+=1;assert.equal(predicate(response),true);for(const origin of ['https://evil.example','https://seller-ph.tiktok.com'])assert.equal(predicate({...response,url:()=>`${origin}${rules.list_endpoint}?${rules.seller_query}=88001`}),false);return response;},goto:async(url,settings)=>{gotos.push({url,settings});}};
  const browserContext={pages:()=>[page]}; const browser={isConnected:()=>true,contexts:()=>[browserContext]};
  const outputDir=path.join(root,'stage'); fs.mkdirSync(outputDir);
  const input={a:{},b:{seller_page_url:sellerUrl},shop:{seller_id:'88001',provider_id:'cross_border'},route:null,reportSpec:spec,providerSpec:provider,outputDir,startDate:'2026-08-20',endDate:'2026-08-20'};
  const result=await module.run(input,{browser,browserContext,currencyText:'₱'}); const entered=new URL(gotos[0].url);
  assert.equal(result.status,'no_data'); assert.equal(result.provider_id,'cross_border'); assert.equal(waits,1);
  assert.equal(entered.origin,new URL(sellerUrl).origin); assert.equal(entered.pathname,'/sentinel-product-analytics');

  const unsupported=structuredClone(input); unsupported.shop.provider_id='local'; unsupported.outputDir=path.join(root,'unsupported'); fs.mkdirSync(unsupported.outputDir);
  await assert.rejects(module.run(unsupported,{browser,browserContext}),{code:'report_provider_unsupported'});
  assert.equal(gotos.length,1); assert.equal(fs.readdirSync(unsupported.outputDir).length,0);
});

test('Product Analytics counts nonempty rows from MD data_start_row without inspecting headers', (t) => {
  const root = temporary(t); const spec = loadReportMd().specs.product_analytics_performance;
  const provider = spec.providers.cross_border; const row = ['arbitrary', '', 'record'];
  const rows = [
    ['unvalidated banner'], [], [], ['future', 'headers', 'accepted'], row,
  ];
  const file = path.join(root, 'product.xlsx'); writeWorkbook(file, rows);
  assert.equal(runner('product_analytics_performance').inspectOfficial(fs.readFileSync(file), provider), 1);
  const empty = path.join(root, 'product-empty.xlsx'); writeWorkbook(empty, rows.slice(0, 4));
  assert.throws(() => runner('product_analytics_performance').inspectOfficial(fs.readFileSync(empty), provider), { code:'official_data_row_count_mismatch' });
});

test('CSV logical record helper handles quoting and strict UTF-8 without fixing content fields', () => {
  for (const [name, bytes, expected] of [
    ['ordinary', Buffer.from('header,value\nrow,data\n'), 1],
    ['arbitrary-header-and-bom', Buffer.from('\ufefffuture;columns\nrow;data\n'), 1],
    ['quoted-newline', Buffer.from('header,value\nrow,"line one\nline two"\n'), 1],
    ['escaped-quote', Buffer.from('header,value\nrow,"said ""hello"""\n'), 1],
    ['crlf', Buffer.from('header,value\r\nrow,data\r\n'), 1],
    ['multiple-records', Buffer.from('header,value\nrow,one\nrow,two\n'), 2],
  ]) assert.equal(countCsvDataRows(bytes, 2), expected, name);

  for (const [name, bytes, code] of [
    ['invalid-utf8', Buffer.from([0x68, 0x0a, 0xc3, 0x28]), 'official_csv_invalid'],
    ['unclosed-quote', Buffer.from('header,value\nrow,"unfinished\n'), 'official_csv_invalid'],
    ['header-only', Buffer.from('header,value\n'), 'official_data_row_count_mismatch'],
    ['delimiter-only', Buffer.from('header,value\n,,,\n;;;\n\t\t\n""\n'), 'official_data_row_count_mismatch'],
  ]) assert.throws(() => countCsvDataRows(bytes, 2), { code }, name);
});

test('order CSV runner delegates logical-record counting without enforcing headers or delimiter', () => {
  const order = loadReportMd().specs.manage_orders_csv; const provider = order.providers.cross_border;
  const bytes = Buffer.from('future\theaders\r\nrow\t"line one\r\nline two"\r\n');
  assert.equal(runner('manage_orders_csv').inspectCsv(bytes, order, provider), 1);
});

test('orders provider contract allows metadata, rejects missing rules, and matches only its official response origin', async () => {
  const orders = runner('manage_orders_csv'); const spec = structuredClone(loadReportMd().specs.manage_orders_csv); const provider=spec.providers.cross_border; const rules=provider.official_validation; const ui = rules.ui_contract;
  assert.equal(ui.list_method, 'POST');
  assert.equal(provider.list_response_origin, 'https://seller.tiktokshopglobalselling.com');
  assert.equal(provider.task_response_origin, 'https://api16-normal-sg.tiktokshopglobalselling.com');
  assert.equal(provider.response_origin, undefined);
  spec.audit_metadata=true; provider.audit_metadata=true; rules.audit_metadata=true; assert.equal(orders.validateSpec(spec,provider,{skillRoot:ROOT}),spec);
  const missing=structuredClone(spec); delete missing.providers.cross_border.official_validation.create_endpoint; assert.throws(()=>orders.validateSpec(missing,missing.providers.cross_border,{skillRoot:ROOT}),{code:'orders_report_spec_invalid'});
  for(const value of [undefined,0,'2']){const invalid=structuredClone(spec);if(value===undefined)delete invalid.providers.cross_border.official_validation.data_start_row;else invalid.providers.cross_border.official_validation.data_start_row=value;assert.throws(()=>orders.validateSpec(invalid,invalid.providers.cross_border,{skillRoot:ROOT}),{code:'orders_report_spec_invalid'});}
  for(const value of [undefined,'Invalid/Timezone']){const invalid=structuredClone(spec);if(value===undefined)delete invalid.providers.cross_border.official_validation.business_timezone;else invalid.providers.cross_border.official_validation.business_timezone=value;assert.throws(()=>orders.validateSpec(invalid,invalid.providers.cross_border,{skillRoot:ROOT}),{code:'orders_report_spec_invalid'});}
  for(const field of ['list_response_origin','task_response_origin'])for(const value of [undefined,'http://evil.example','https://evil.example/path']){const invalid=structuredClone(spec);if(value===undefined)delete invalid.providers.cross_border[field];else invalid.providers.cross_border[field]=value;assert.throws(()=>orders.validateSpec(invalid,invalid.providers.cross_border,{skillRoot:ROOT}),{code:'orders_report_spec_invalid'});}
  ui.dialog_selector = '[data-sentinel="dialog"]'; ui.radio_selector = '[data-sentinel="radio"]'; ui.export_button_name = 'Sentinel Export'; ui.entry_query = { selected_sort: { name: 'sentinel_sort', value: 'S' }, tab: { name: 'sentinel_tab', value: 'T' }, created_time: 'sentinel_time' }; ui.list_method = 'POST'; ui.response_paths.list_total = ['sentinel', 'total'];
  assert.equal(orders.validateSpec(spec,provider,{skillRoot:ROOT}), spec);
  const url = require('../scripts/routes/common/manage_orders_csv_v3').reportUrl('https://seller.example', '/sentinel-orders', '2026-08-20', '2026-08-20', 'Asia/Manila', ui);
  assert.equal(url.searchParams.get('sentinel_sort'), 'S'); assert.equal(url.searchParams.get('sentinel_tab'), 'T'); assert.equal(url.searchParams.getAll('sentinel_time').length, 2);
  const observed = []; const dialog = { locator: (selector) => { observed.push(selector); return { count: async () => ui.radio_count }; }, getByRole: (_role, options) => { observed.push(options.name); return { count: async () => 1 }; } };
  const page = { locator: (selector) => { observed.push(selector); return { count: async () => 1, nth: () => dialog }; } };
  const sellerUrl='https://seller.tiktokshopglobalselling.com/home'; const responseUrl=`${provider.list_response_origin}${rules.list_endpoint}?${ui.seller_query}=88001`; const response={url:()=>responseUrl,request:()=>({method:()=>ui.list_method}),status:()=>200,json:async()=>({code:0,sentinel:{total:0}})}; let gotos=0;let gotoOptions=null;
  const runPage={url:()=>sellerUrl,waitForResponse:async(predicate)=>{assert.equal(predicate(response),true);for(const origin of ['https://evil.example','https://seller-ph.tiktok.com',provider.task_response_origin])assert.equal(predicate({...response,url:()=>`${origin}${rules.list_endpoint}?${ui.seller_query}=88001`}),false);assert.equal(predicate({...response,url:()=>`${provider.list_response_origin}${rules.list_endpoint}?${ui.seller_query}=wrong-seller`}),false);return response;},goto:async(_url,options)=>{gotos+=1;gotoOptions=options;}};
  const browserContext={pages:()=>[runPage]};const browser={isConnected:()=>true,contexts:()=>[browserContext]};const outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'orders-provider-'));try{const result=await orders.run({a:{},b:{seller_page_url:sellerUrl},shop:{seller_id:'88001',provider_id:'cross_border'},route:null,reportSpec:spec,providerSpec:provider,outputDir,startDate:'2026-08-20',endDate:'2026-08-20'},{browser,browserContext,skillRoot:ROOT,currencyText:'₱'});assert.equal(result.status,'no_data');assert.equal(gotos,1);assert.equal(gotoOptions.waitUntil,'commit');}finally{fs.rmSync(outputDir,{recursive:true,force:true});}
  const timeoutDir=fs.mkdtempSync(path.join(os.tmpdir(),'orders-timeout-'));const timeoutPage={url:()=>sellerUrl,waitForResponse:async()=>{const error=new Error('Timeout 90000ms exceeded');error.name='TimeoutError';throw error;},goto:async()=>{}};const timeoutContext={pages:()=>[timeoutPage]};const timeoutBrowser={isConnected:()=>true,contexts:()=>[timeoutContext]};try{await assert.rejects(orders.run({a:{},b:{seller_page_url:sellerUrl},shop:{seller_id:'88001',provider_id:'cross_border'},route:null,reportSpec:spec,providerSpec:provider,outputDir:timeoutDir,startDate:'2026-08-20',endDate:'2026-08-20'},{browser:timeoutBrowser,browserContext:timeoutContext,skillRoot:ROOT}),{code:'order_list_response_not_observed'});}finally{fs.rmSync(timeoutDir,{recursive:true,force:true});}
  const fatalDir=fs.mkdtempSync(path.join(os.tmpdir(),'orders-timeout-fatal-'));let connected=true;const fatalPage={url:()=>sellerUrl,waitForResponse:async()=>{connected=false;const error=new Error('Timeout 90000ms exceeded');error.name='TimeoutError';throw error;},goto:async()=>{}};const fatalContext={pages:()=>[fatalPage]};const fatalBrowser={isConnected:()=>connected,contexts:()=>[fatalContext]};try{await assert.rejects(orders.run({a:{},b:{seller_page_url:sellerUrl},shop:{seller_id:'88001',provider_id:'cross_border'},route:null,reportSpec:spec,providerSpec:provider,outputDir:fatalDir,startDate:'2026-08-20',endDate:'2026-08-20'},{browser:fatalBrowser,browserContext:fatalContext,skillRoot:ROOT}),{code:'browser_disconnected'});}finally{fs.rmSync(fatalDir,{recursive:true,force:true});}
  for(const disconnect of [false,true]){const navigationDir=fs.mkdtempSync(path.join(os.tmpdir(),`orders-navigation-${disconnect}-`));let navigationConnected=true;const navigationPage={url:()=>sellerUrl,waitForResponse:()=>new Promise(()=>{}),goto:async(_url,options)=>{assert.equal(options.waitUntil,'commit');if(disconnect)navigationConnected=false;const error=new Error('Navigation timeout');error.name='TimeoutError';throw error;}};const navigationContext={pages:()=>[navigationPage]};const navigationBrowser={isConnected:()=>navigationConnected,contexts:()=>[navigationContext]};try{await assert.rejects(orders.run({a:{},b:{seller_page_url:sellerUrl},shop:{seller_id:'88001',provider_id:'cross_border'},route:null,reportSpec:spec,providerSpec:provider,outputDir:navigationDir,startDate:'2026-08-20',endDate:'2026-08-20'},{browser:navigationBrowser,browserContext:navigationContext,skillRoot:ROOT}),{code:disconnect?'browser_disconnected':'order_page_navigation_timeout'});}finally{fs.rmSync(navigationDir,{recursive:true,force:true});}}
});

test('orders record stages accept only the task response origin and select a post-click task', async () => {
  const orders=runner('manage_orders_csv');const spec=structuredClone(loadReportMd().specs.manage_orders_csv);const provider=spec.providers.cross_border;const rules=provider.official_validation;const ui=rules.ui_contract;
  const item=(origin,pathname,method='POST')=>({url:()=>`${origin}${pathname}`,request:()=>({method:()=>method})});
  const record={export_task_id:'task-1',file_key:'key-1',file_name:'orders.csv'};const recordResponse={...item(provider.task_response_origin,rules.record_endpoint,ui.record_method),status:()=>200,json:async()=>({data:{export_records:[record]}})};
  const recordPage={waitForResponse:async(predicate)=>{assert.equal(predicate(recordResponse),true);for(const origin of [provider.list_response_origin,'https://seller-ph.tiktok.com','https://evil.example'])assert.equal(predicate({...recordResponse,url:()=>`${origin}${rules.record_endpoint}`}),false);return recordResponse;}};
  assert.equal(await orders.waitTask(recordPage,provider,'task-1',1000,ui),record);
  const {waitForCreatedTask}=require('../scripts/routes/common/manage_orders_task_binding');const created={...item(provider.task_response_origin,'/api/future/export','PUT'),status:()=>200,json:async()=>({result:{task_id:'task-2'}})};const page={waitForResponse:async(predicate)=>{assert.equal(await predicate(created),true);return created;}};assert.deepEqual(await waitForCreatedTask(page,provider,1000,ui,()=>true,async()=>{}),{taskId:'task-2',known_contract:false});
});

test('orders bind the record filename but ignore the downloaded basename and preserve CSV bytes', async (t) => {
  const root=temporary(t);const orders=runner('manage_orders_csv');const spec=structuredClone(loadReportMd().specs.manage_orders_csv);const provider=spec.providers.cross_border;const rules=provider.official_validation;const ui=rules.ui_contract;const sellerId='88001';const sellerUrl=`${provider.list_response_origin}/home`;const taskId='8132317783372833540';
  const row=Array(spec.headers.length).fill('');row[spec.headers.indexOf('Order ID')]='ORDER-1';row[spec.headers.indexOf('Created Time')]='08/20/2026 10:30:00';const csvFile=path.join(root,'official.csv');writeCsv(csvFile,[spec.headers,row]);const bytes=fs.readFileSync(csvFile);
  const execute=async(recordFilename,suggestedFilename,name)=>{const outputDir=path.join(root,name);fs.mkdirSync(outputDir);let waits=0;let downloadClicks=0;const downloadButton={count:async()=>1,click:async()=>{downloadClicks+=1;}};const nameMatch={count:async()=>1,first:()=>({locator:()=>({getByRole:()=>downloadButton})})};const radios={count:async()=>ui.radio_count,nth:(index)=>({isChecked:async()=>ui.required_checked_indices.includes(index)})};const dialog={locator:()=>radios,getByRole:()=>({count:async()=>1,click:async()=>{}}),getByText:(value,options)=>{assert.equal(value,recordFilename);assert.equal(options.exact,true);return nameMatch;}};
    const page={url:()=>sellerUrl,locator:()=>({count:async()=>1,nth:()=>dialog}),goto:async(_url,options)=>{assert.equal(options.waitUntil,'commit');},waitForEvent:async(event)=>{assert.equal(event,'download');return{suggestedFilename:()=>suggestedFilename,createReadStream:async()=>({async *[Symbol.asyncIterator](){yield bytes;}})};},waitForResponse:async(predicate)=>{waits+=1;if(waits===1){const response={url:()=>`${provider.list_response_origin}${rules.list_endpoint}?${ui.seller_query}=${sellerId}`,request:()=>({method:()=>ui.list_method}),status:()=>200,json:async()=>({code:0,data:{total_count:1}})};assert.equal(await predicate(response),true);return response;}if(waits===2){await new Promise((resolve)=>setImmediate(resolve));const response={url:()=>`${provider.task_response_origin}${rules.create_endpoint}`,request:()=>({method:()=>ui.create_method}),status:()=>200,json:async()=>({code:0,data:{export_task_id:taskId}})};assert.equal(await predicate(response),true);return response;}await new Promise((resolve)=>setImmediate(resolve));const response={url:()=>`${provider.task_response_origin}${rules.record_endpoint}`,request:()=>({method:()=>ui.record_method}),status:()=>200,json:async()=>({code:0,data:{export_records:[{export_task_id:taskId,file_key:'key-1',file_name:encodeURIComponent(recordFilename)}]}})};assert.equal(await predicate(response),true);return response;}};
    const browserContext={pages:()=>[page]};const browser={isConnected:()=>true,contexts:()=>[browserContext]};const input={a:{},b:{seller_page_url:sellerUrl},shop:{seller_id:sellerId,provider_id:'cross_border'},route:null,reportSpec:spec,providerSpec:provider,outputDir,startDate:'2026-08-20',endDate:'2026-08-20'};return{promise:orders.run(input,{browser,browserContext,skillRoot:ROOT,currencyText:'₱'}),getDownloadClicks:()=>downloadClicks};};
  const record='official task label.csv';const success=await execute(record,'arbitrary-server-name.bin','success');const result=await success.promise;assert.equal(result.status,'success');assert.equal(result.official_filename,undefined);assert.equal(path.extname(result.output_file),'.csv');assert.deepEqual(fs.readFileSync(result.output_file),bytes);assert.equal(success.getDownloadClicks(),1);
});

test('overview validator counts every nonempty data row without inspecting headers or business values', (t) => {
  const root = temporary(t); const spec = loadReportMd().specs.gmvmax_campaign_overview; const provider=spec.providers.cross_border;
  assert.deepEqual(spec.headers,['时间','成本','SKU orders (Current shop)','Cost per order (Current shop)','Gross revenue (Current shop)','ROI (Current shop)','币种']);
  const rows = [spec.headers];
  for (let hour = 0; hour < 24; hour += 1) rows.push([`2026-08-20 ${String(hour).padStart(2, '0')}:00:00`, ...Array(6).fill('1')]);
  rows.push(['-', ...Array(6).fill('1')]);
  const file = path.join(root, 'overview.xlsx'); writeWorkbook(file, rows);
  assert.equal(runner('gmvmax_campaign_overview').inspectWorkbook(fs.readFileSync(file), spec, provider.official_validation), 25);
  const oldHeaders=[...spec.headers];oldHeaders[1]='Future Cost';const oldFile=path.join(root,'overview-old-cost.xlsx');writeWorkbook(oldFile,[oldHeaders,...rows.slice(1)]);assert.equal(runner('gmvmax_campaign_overview').inspectWorkbook(fs.readFileSync(oldFile),spec,provider.official_validation),25);

  const ranged = [spec.headers,
    ['2026-08-20 23:00:00', ...Array(6).fill('1')],
    ['2026-08-21 00:00:00', ...Array(6).fill('1')],
    ['2026-08-21 07:00:00', ...Array(6).fill('1')],
    ['-', ...Array(6).fill('1')]];
  const rangedFile = path.join(root, 'overview-ranged.xlsx'); writeWorkbook(rangedFile, ranged);
  assert.equal(runner('gmvmax_campaign_overview').inspectWorkbook(fs.readFileSync(rangedFile), spec, provider.official_validation), 4);
  const empty = path.join(root, 'overview-empty.xlsx'); writeWorkbook(empty, [['changed headers']]);
  assert.throws(() => runner('gmvmax_campaign_overview').inspectWorkbook(fs.readFileSync(empty), spec, provider.official_validation), { code:'official_data_row_count_mismatch' });
});

test('overview providers select the exact date and click one official download button', async (t) => {
  const root=temporary(t);const loaded=loadReportMd();
  for(const providerId of ['cross_border','local']){
    const spec=structuredClone(loaded.specs.gmvmax_campaign_overview);const provider=spec.providers[providerId];const module=require(path.join(ROOT,provider.runner));const outputDir=path.join(root,providerId);fs.mkdirSync(outputDir);
    assert.equal(provider.transport,'seller_ui_direct_download');assert.equal(module.validateSpec(spec,provider,{skillRoot:ROOT}),spec);
    const missing=structuredClone(spec);delete missing.providers[providerId].official_validation.export_selector;assert.throws(()=>module.validateSpec(missing,missing.providers[providerId],{skillRoot:ROOT}),{code:'campaign_overview_report_spec_invalid'});
    const officialFile=path.join(root,`${providerId}-official.xlsx`);writeWorkbook(officialFile,[spec.headers,['2026-08-26',...Array(spec.headers.length-1).fill('1')]]);const officialBytes=fs.readFileSync(officialFile);
    let current=`${provider.response_origin}/home`,clicks=0,applied=null,overlayChecks=0;
    const button={isVisible:async()=>true,isEnabled:async()=>true,click:async()=>{clicks+=1;}};
    const page={url:()=>current,goto:async(url)=>{current=url;},locator:(selector)=>{assert.equal(selector,provider.official_validation.export_selector);return{count:async()=>1,nth:()=>button};},waitForEvent:async(event)=>{assert.equal(event,'download');return{createReadStream:async()=>({async *[Symbol.asyncIterator](){yield officialBytes;}})};}};
    const browserContext={pages:()=>[page]};const browser={isConnected:()=>true,contexts:()=>[browserContext]};
    const result=await module.run({a:{},b:{seller_page_url:`${provider.response_origin}/home`},shop:{seller_id:'88001',provider_id:providerId},reportSpec:spec,providerSpec:provider,outputDir,startDate:'2026-08-26',endDate:'2026-08-26',advertiserId:'99001',businessCenterId:'77001'},{browser,browserContext,skillRoot:ROOT,applyDateRange:async(_page,startDate,endDate)=>{applied=[startDate,endDate];},dismissBlockingOverlay:async()=>{overlayChecks+=1;},captureDownload:async()=>officialBytes});
    assert.equal(result.status,'success');assert.deepEqual(applied,['2026-08-26','2026-08-26']);assert.equal(overlayChecks,2);assert.equal(clicks,1);assert.deepEqual(fs.readFileSync(result.output_file),officialBytes);
  }
});

test('overview clicks each endpoint, fills the exact range, and verifies the applied input values',async()=>{const spec=loadReportMd().specs.gmvmax_campaign_overview;for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),rules={...spec.providers[providerId].official_validation,picker_timeout_ms:30},values=['2026-08-26','2026-09-02'],events=[];const inputs=[0,1].map((index)=>({isVisible:async()=>true,inputValue:async()=>values[index],click:async()=>{events.push(['click',index]);},fill:async(value)=>{events.push(['fill',index,value]);values[index]=index===1&&value==='bad'?'wrong':value;},press:async(key)=>{events.push(['press',index,key]);}}));const root={isVisible:async()=>true,locator:(selector)=>{assert.equal(selector,rules.date_input_selector);return locator(inputs);}};const page={locator:(selector)=>{assert.equal(selector,rules.date_root_selector);return locator([root]);}};await module.applyDateRange(page,'2026-07-01','2026-07-31',rules,async()=>{});assert.deepEqual(values,['2026-07-01','2026-07-31']);assert.deepEqual(events,[['click',0],['fill',0,'2026-07-01'],['press',0,'Tab'],['click',1],['fill',1,'2026-07-31'],['press',1,'Enter']]);await assert.rejects(module.applyDateRange(page,'2026-07-01','bad',rules,async(ms)=>new Promise(resolve=>setTimeout(resolve,Math.min(ms,1)))),{code:'campaign_overview_date_not_applied'});}}
);

test('overview binds the UI-created task, polls it to success, and downloads the official XLSX',async(t)=>{const root=temporary(t),file=path.join(root,'overview-task.xlsx'),spec=loadReportMd().specs.gmvmax_campaign_overview;writeWorkbook(file,[spec.headers,['2026-07-01',...Array(spec.headers.length-1).fill('1')]]);const official=fs.readFileSync(file);for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),provider=spec.providers[providerId],rules={...provider.official_validation,poll_interval_ms:1,max_polls:3},taskId='7680855372289982472',signed='https://download.example/overview.xlsx',urlFor=(endpoint)=>{const url=new URL(endpoint,provider.response_origin);url.searchParams.set(rules.query_parameters.seller_id,'88001');url.searchParams.set(rules.query_parameters.advertiser_id,'99001');for(const[key,value]of Object.entries(rules.query_constants))url.searchParams.set(key,String(value));return url.href;},response=(url,body,status=200,headers={})=>({url:()=>url,status:()=>status,body:async()=>Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body)),headers:()=>headers});let polls=0;const page={url:()=>`${provider.response_origin}/home`,request:{fetch:async(url,options)=>{assert.equal(options.data[rules.task_query_request.task_id_field],taskId);polls+=1;return response(url,{code:0,download_id:taskId,task_status:polls===1?'PENDING':'SUCCESS',url:polls===1?'':signed});}}};const browserContext={pages:()=>[page],request:{get:async(url)=>{assert.equal(url,signed);return response(url,official,200,{'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});}}},browser={isConnected:()=>true,contexts:()=>[browserContext]},context={browser,browserContext,page,origin:provider.response_origin},created=response(urlFor(rules.create_endpoint),{code:0,extra:{task_id:taskId}});assert.deepEqual(await module.taskDownload(context,{shop:{seller_id:'88001'},advertiserId:'99001'},rules,created,async()=>{}),official);assert.equal(polls,2);}});

test('creative performance preserves official header changes and requires nonempty data rows', (t) => {
  const root = temporary(t); const spec = loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  assert.deepEqual(spec.published_identity_columns, ['product_id']);
  assert.equal(spec.headers.at(-1), 'product_id');
  assert.deepEqual(spec.headers.slice(8, 12), ['成本', 'SKU 订单数', '平均下单成本', '总收入']);
  const row = Array(spec.headers.length).fill('value'); row[0] = 'video-post-A';
  for (const providerId of ['cross_border', 'local']) {
    const provider = spec.providers[providerId];
    const headers = [...spec.headers]; headers[4] = providerId === 'local' ? 'Creative source' : 'Video source';
    const file = path.join(root, `${providerId}-creative.xlsx`); writeWorkbook(file, [headers, row]);
    const duplicate = path.join(root, `${providerId}-creative-duplicate.xlsx`); writeWorkbook(duplicate, [headers, row, row]);
    const oldHeaders = [...headers]; oldHeaders.splice(8, 4, 'Cost', 'SKU orders', 'Cost per order', 'Gross revenue');
    const oldFile = path.join(root, `${providerId}-creative-old-headers.xlsx`); writeWorkbook(oldFile, [oldHeaders, row]);
    const empty = path.join(root, `${providerId}-creative-empty.xlsx`); writeWorkbook(empty, [headers]);
    const module = require(path.join(ROOT, spec.providers[providerId].runner));
    assert.equal(module.inspectWorkbook(fs.readFileSync(file), spec, provider), 1);
    assert.equal(module.inspectWorkbook(fs.readFileSync(duplicate), spec, provider), 2);
    assert.equal(module.inspectWorkbook(fs.readFileSync(oldFile), spec, provider), 1);
    assert.throws(() => module.inspectWorkbook(fs.readFileSync(empty), spec, provider), { code:'official_data_row_count_mismatch' });
  }
});

test('creative performance providers keep independent four-step UI runners and forbid task APIs', () => {
  const spec = loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for (const providerId of ['cross_border', 'local']) {
    const provider = spec.providers[providerId]; const module = require(path.join(ROOT, provider.runner));
    assert.equal(provider.transport, 'seller_ui_four_step_official_download');
    assert.equal(provider.official_validation.download_batch_size, 3);
    assert.equal(provider.official_validation.download_start_timeout_ms, 30000);
    assert.equal(provider.official_validation.download_retry_limit, 1);
    assert.equal(provider.official_validation.download_timeout_ms, 1200000);
    assert.equal(provider.official_validation.export_loading_class, 'theme-arco-btn-loading');
    assert.equal(module.validateSpec(spec, provider, { skillRoot:ROOT }), spec);
    const source = fs.readFileSync(path.join(ROOT, provider.runner), 'utf8');
    for (const forbidden of ['creative_endpoint','task_query_endpoint','spu_id_list','Export History','browserContext.request.get','official_header_mismatch']) assert.equal(source.includes(forbidden), false, `${providerId}:${forbidden}`);
    assert.ok(source.indexOf('campaign_action_selector') < source.indexOf('product_action_selector'));
    assert.ok(source.indexOf('const cdp=await setupCapture') < source.indexOf('await startUnit'));
    assert.match(source, /Browser\.setDownloadBehavior/u);
    assert.match(source, /Browser\.downloadWillBegin/u);
    assert.match(source, /waitForDownloadStarts/u);
    assert.match(source, /classList\.contains\(loadingClass\)/u);
    assert.match(source, /current=await openProductPage\(worker,r,x\)/u);
    assert.equal(source.includes('productAction(worker'), false, `${providerId}:repeated-product-navigation`);
    assert.equal(source.includes('if(ref!=null&&digits(ref))return products'), false, `${providerId}:explicit-product-full-traversal`);
    for(const forbidden of ["waitForEvent('download'",'saveAs(','default Downloads','.fill(','.type(','purestatedatepicker'])assert.equal(source.includes(forbidden),false,`${providerId}:${forbidden}`);
    for (const stale of ['.theme-arco-table-tbody', '.arco-table-tbody', '[data-field="campaign_id"]', '[data-field="product_id"]', 'date_url_range_key']) assert.equal(source.includes(stale), false, `${providerId}:${stale}`);
    assert.equal(provider.official_validation.campaign_action_selector, '[data-testid="actions-index-osAPKg"][data-btm$=":viewdata"]');
    assert.equal(provider.official_validation.product_action_selector, '[data-testid="actions-index-osAPKg"][data-btm$=":view_creative"]');
    assert.match(provider.official_validation.date_root_selector, /dashboard-date-picker-index-rF7379/u);
    assert.match(provider.official_validation.date_cell_selector, /picker-cell-in-view:not\(.theme-arco-picker-cell-disabled\)/u);
    assert.match(provider.official_validation.export_selector, /export_button_view_data_creative_0/u);
  }
  assert.notEqual(spec.providers.cross_border.runner, spec.providers.local.runner);
});

test('creative CDP capture setup precedes click and setup failure stays click-free', async () => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),calls=[];let detached=0,clicks=0;const cdp={send:async(method,params)=>{calls.push({method,params});},detach:async()=>{detached+=1;}};const context={page:{},browserContext:{newCDPSession:async()=>cdp}};const capture='D:\\capture-unit';assert.equal(await module.setupCapture(context,capture),cdp);assert.deepEqual(calls,[{method:'Browser.setDownloadBehavior',params:{behavior:'allow',downloadPath:capture,eventsEnabled:true}}]);await cdp.detach();assert.equal(detached,1);const failed={page:{},browserContext:{newCDPSession:async()=>({send:async()=>{throw new Error('unsupported');},detach:async()=>{detached+=1;}})}};await assert.rejects(module.setupCapture(failed,capture),{code:'official_download_capture_setup_failed'});assert.equal(clicks,0);}
});

test('creative capture polls crdownload to one stable exact XLSX and rejects invalid shapes', async (t) => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),base=spec.providers[providerId].official_validation,rules={...base,download_timeout_ms:120,download_capture:{...base.download_capture,poll_interval_ms:1,stable_polls:2}},root=temporary(t),dir=path.join(root,providerId);fs.mkdirSync(dir);assert.deepEqual(fs.readdirSync(dir),[]);const filename='Creative data 2026-08-01 - 2026-08-29 - Product 501.xlsx';let step=0;const delay=async()=>{step+=1;if(step===1)fs.writeFileSync(path.join(dir,`${filename}.crdownload`),'partial');if(step===2){fs.rmSync(path.join(dir,`${filename}.crdownload`));fs.writeFileSync(path.join(dir,filename),Buffer.from([0x50,0x4b,1]));}};assert.equal(await module.captureOfficial(dir,filename,rules,{delay}),path.join(dir,filename));assert.ok(step>=3);
    const wrong=path.join(root,`${providerId}-wrong`);fs.mkdirSync(wrong);fs.writeFileSync(path.join(wrong,'wrong.xlsx'),'x');await assert.rejects(module.captureOfficial(wrong,filename,rules),{code:'official_download_invalid'});
    const many=path.join(root,`${providerId}-many`);fs.mkdirSync(many);fs.writeFileSync(path.join(many,filename),'x');fs.writeFileSync(path.join(many,'second.xlsx'),'x');await assert.rejects(module.captureOfficial(many,filename,rules),{code:'official_download_invalid'});
    const timeout=path.join(root,`${providerId}-timeout`);fs.mkdirSync(timeout);await assert.rejects(module.captureOfficial(timeout,filename,{...rules,download_timeout_ms:20}),{code:'official_download_timeout'});
  }
});

function locator(items) {
  return { count:async()=>items.length, nth:(index)=>items[index] };
}

function monthNavigationDom(rules, before, after, lag = 3) {
  let clicked=false;let reads=0;const clicks=[];
  const control=(name)=>({isVisible:async()=>true,click:async()=>{clicked=true;clicks.push(name);}});
  const panel=(label,index)=>({label,isVisible:async()=>true,locator:(selector)=>{
    if(selector===rules.date_header_selector)return locator([{isVisible:async()=>true,innerText:async()=>label}]);
    if(rules.date_previous_month_selector&&selector===rules.date_previous_month_selector)return locator(index===0?[control('previous')]:[]);
    if(rules.date_next_month_selector&&selector===rules.date_next_month_selector)return locator(index===1?[control('next')]:[]);
    if(selector===rules.date_header_control_selector){
      if(rules.date_previous_month_selector)throw new Error('local month navigation must not use visible placeholder positions');
      return locator(index===0?[control('noop'),control('previous')]:[control('next'),control('noop')]);
    }
    return locator([]);
  }});
  const trigger={isVisible:async()=>true,locator:(selector)=>{assert.equal(selector,rules.date_panel_selector);reads+=1;const labels=clicked&&reads>=lag?after:before;return locator(labels.map(panel));}};
  return {page:{locator:(selector)=>{assert.equal(selector,rules.date_trigger_selector);return locator([trigger]);}},clicks};
}

test('overview and creative month navigation parses localized labels and waits for a real month change', async () => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){
    const module=require(path.join(ROOT,spec.providers[providerId].runner));const rules={...spec.providers[providerId].official_validation,picker_timeout_ms:100,date_max_month_moves:2};
    assert.equal(module.monthIndex('2026年7月'),module.monthIndex('July 2026'));
    const previous=monthNavigationDom(rules,['August 2026','September 2026'],['July 2026','August 2026']);const selected=await module.monthPanel(previous.page,'2026-07',rules);assert.equal(selected.label,'July 2026');assert.deepEqual(previous.clicks,['previous']);
    const next=monthNavigationDom(rules,['May 2026','June 2026'],['June 2026','July 2026']);await module.monthPanel(next.page,'2026-07',rules);assert.deepEqual(next.clicks,['next']);
  }
});

test('local creative rejects a wrong-direction or stationary month transition',async()=>{
  const rules={...loadReportMd().specs.gmvmax_campaign_product_creative_performance.providers.local.official_validation,picker_timeout_ms:40,date_max_month_moves:2};
  const module=require('../scripts/routes/local/gmvmax_campaign_product_creative_performance');
  await assert.rejects(module.monthPanel(monthNavigationDom(rules,['September 2026','October 2026'],['October 2026','November 2026']).page,'2026-08',rules),{code:'creative_date_navigation_changed'});
  await assert.rejects(module.monthPanel(monthNavigationDom(rules,['September 2026','October 2026'],['September 2026','October 2026']).page,'2026-08',rules),{code:'creative_date_month_unreachable'});
});

function creativeDom(rules, options = {}) {
  let scopedClicks = 0;
  const rows = locator(Array.from({length:options.rows ?? 10},()=>({isVisible:async()=>true})));
  const header = {isVisible:async()=>options.headerVisible !== false};
  const table = {isVisible:async()=>options.tableVisible !== false,getByText:(value,{exact})=>{assert.equal(value,rules.creative_header_text);assert.equal(exact,true);return locator([header]);},locator:(selector)=>{assert.equal(selector,rules.creative_row_selector);return rows;}};
  const zero = {isVisible:async()=>options.zeroVisible === true};
  const button = {isVisible:async()=>true,isEnabled:async()=>options.buttonEnabled !== false,click:async()=>{scopedClicks+=1;}};
  const root = {isVisible:async()=>true,locator:(selector)=>selector===rules.creative_table_selector?locator([table]):selector===rules.export_selector?locator([button]):locator([]),getByText:(value,{exact})=>{assert.equal(value,rules.zero_text);assert.equal(exact,true);return locator(options.zeroPresent===false?[]:[zero]);}};
  const hiddenModalZero = {isVisible:async()=>false};
  const page = {locator:(selector)=>selector===rules.creative_root_selector?locator(options.rootMissing?[]:[root]):selector.includes('theme-arco')||selector.includes('data-field')?locator([]):locator([hiddenModalZero])};
  return {page,getScopedClicks:()=>scopedClicks};
}

test('creative state ignores stale selectors and hidden page modal, and requires scoped ready evidence', async () => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),rules=spec.providers[providerId].official_validation,dom=creativeDom(rules);const state=await module.creativeState(dom.page,rules);assert.equal(state.status,'ready');assert.equal(state.rowCount,10);await state.button.click();assert.equal(dom.getScopedClicks(),1);}
});

test('creative state accepts only scoped visible exact zero with zero tbody rows', async () => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),rules={...spec.providers[providerId].official_validation,picker_timeout_ms:30};assert.equal((await module.creativeState(creativeDom(rules,{rows:0,zeroVisible:true}).page,rules)).status,'no_data');await assert.rejects(module.creativeState(creativeDom(rules,{rows:0,zeroVisible:false}).page,rules),{code:'creative_export_control_not_ready'});await assert.rejects(module.creativeState(creativeDom(rules,{rootMissing:true}).page,rules),{code:'creative_export_control_not_ready'});}
});

function dateCalendarDom(rules, options={}) {
  let open=false;const values=['2026-08-24','2026-08-31'],clicks=[];
  const inputs=[0,1].map(index=>({isVisible:async()=>true,inputValue:async()=>values[index]}));
  const root={isVisible:async()=>true,click:async()=>{clicks.push('dashboard');open=true;},locator:(selector)=>{assert.equal(selector,rules.date_input_selector);return locator(inputs);}};
  const hiddenRoot={isVisible:async()=>false,locator:(selector)=>{assert.equal(selector,rules.date_input_selector);return locator(inputs.map(input=>({...input,isVisible:async()=>false})));}};
  const cell=(day,action)=>({isVisible:async()=>true,innerText:async()=>String(day),click:async()=>{clicks.push(day);action();}});
  const augustCells=[cell(1,()=>{values[0]='2026-08-01';}),cell(29,()=>{values[1]=options.invalidFinal?'2026-08-28':'2026-08-29';open=false;})];
  const panel=(month,cells)=>({isVisible:async()=>true,locator:(selector)=>{if(selector===rules.date_header_selector)return locator([{isVisible:async()=>true,innerText:async()=>month}]);if(selector===rules.date_header_control_selector)return locator([{isVisible:async()=>true,click:async()=>{}}]);assert.equal(selector,rules.date_cell_selector);return locator(cells);}});
  const trigger={isVisible:async()=>true,locator:(selector)=>{assert.equal(selector,rules.date_panel_selector);return locator([panel('2026-08',augustCells),panel('2026-09',[cell(1,()=>{})])]);}};
  const dateRoots=options.hiddenDuplicateRoot?[hiddenRoot,root]:options.visibleDuplicateRoot?[root,root]:[root];
  const page={locator:(selector)=>{if(selector===rules.date_root_selector)return locator(dateRoots);if(selector===rules.date_trigger_selector)return locator(open?[trigger]:[]);return locator([]);}};
  return{page,values,clicks};
}

test('creative date drives dashboard picker start/end before scoped download and blocks invalid final range', async () => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),base=spec.providers[providerId].official_validation,rules={...base,picker_timeout_ms:100,date_refresh_settle_ms:0},dom=dateCalendarDom(rules);await module.applyDateRange(dom.page,'2026-08-01','2026-08-29',rules);dom.clicks.push('download');assert.deepEqual(dom.clicks,['dashboard',1,29,'download']);assert.deepEqual(dom.values,['2026-08-01','2026-08-29']);const bad=dateCalendarDom(rules,{invalidFinal:true});let downloads=0;await assert.rejects((async()=>{await module.applyDateRange(bad.page,'2026-08-01','2026-08-29',{...rules,picker_timeout_ms:30});downloads+=1;})(),{code:'creative_date_not_applied'});assert.equal(downloads,0);}
});

test('creative date ignores one hidden duplicate root and rejects two visible roots', async () => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),base=spec.providers[providerId].official_validation,rules={...base,picker_timeout_ms:100,date_refresh_settle_ms:0},hidden=dateCalendarDom(rules,{hiddenDuplicateRoot:true});await module.applyDateRange(hidden.page,'2026-08-01','2026-08-29',rules);assert.deepEqual(hidden.values,['2026-08-01','2026-08-29']);const ambiguous=dateCalendarDom(rules,{visibleDuplicateRoot:true});await assert.rejects(module.applyDateRange(ambiguous.page,'2026-08-01','2026-08-29',{...rules,picker_timeout_ms:30}),{code:'creative_date_picker_not_ready'});}
});

test('creative UI timing waits through delayed campaign, product, URL, and scoped button readiness', async () => {
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  for(const providerId of ['cross_border','local']){const module=require(path.join(ROOT,spec.providers[providerId].runner)),rules={...spec.providers[providerId].official_validation,navigation_timeout_ms:160,picker_timeout_ms:160};
    const rowChecks={campaign:0,product:0},action={isVisible:async()=>true};const delayedRows=(kind)=>({count:async()=>{rowChecks[kind]+=1;return rowChecks[kind]>=2?1:0;},nth:()=>({isVisible:async()=>true,locator:()=>locator([action])})});const pageRows={locator:(selector)=>selector===rules.campaign_row_selector?delayedRows('campaign'):delayedRows('product')};assert.deepEqual(await module.actionRows(pageRows,rules.campaign_row_selector,rules.campaign_action_selector,rules.navigation_timeout_ms,'campaign_discovery_failed'),[0]);assert.deepEqual(await module.actionRows(pageRows,rules.product_row_selector,rules.product_action_selector,rules.navigation_timeout_ms,'product_discovery_failed'),[0]);
    let installed=false,current='https://example.test/start';const pageUrl={waitForURL:(predicate,{timeout})=>{installed=true;return new Promise((resolve,reject)=>{const end=Date.now()+timeout;const check=()=>predicate(current)?resolve():Date.now()>=end?reject(new Error('timeout')):setTimeout(check,5);check();});}};await module.clickForUrl(pageUrl,value=>new URL(value).searchParams.get('campaign_id')==='101',{click:async()=>{assert.equal(installed,true);setTimeout(()=>{current='https://example.test/detail?campaign_id=101';},15);}},rules.navigation_timeout_ms,'campaign_discovery_failed');
    let rootChecks=0,buttonChecks=0;const button={isVisible:async()=>true,isEnabled:async()=>++buttonChecks>=2};const table={isVisible:async()=>true,getByText:()=>locator([{isVisible:async()=>true}]),locator:()=>({count:async()=>10})};const root={isVisible:async()=>true,locator:(selector)=>selector===rules.creative_table_selector?locator([table]):locator([button]),getByText:()=>locator([])};const creativePage={locator:()=>({count:async()=>++rootChecks>=2?1:0,nth:()=>root})};assert.equal((await module.creativeState(creativePage,rules)).status,'ready');
    await assert.rejects(module.actionRows({locator:()=>locator([])},rules.campaign_row_selector,rules.campaign_action_selector,30,'campaign_discovery_failed'),{code:'campaign_discovery_failed'});
  }
});
test('generated CSV trusted zero publishes a BOM header-only file and rejects untrusted zero before mkdir', (t) => {
  const root = temporary(t); const spec = loadReportMd().specs.manage_orders_csv;
  const source = path.join(root, 'empty.csv'); writeCsv(source, [spec.headers]);
  const shopRoot = path.join(root, 'shop'); const variables = { start_date: '2026-08-20', end_date: '2026-08-20', time_file: '2026-08-20_至_2026-08-20.csv' };
  const rejected = publishGeneratedCsv({ spec, sourceFile: source, shopRoot, variables, trustedZero: false, expectedStatus: 'no_data', taskId: 't-1' });
  assert.equal(rejected.reason_code, 'zero_data_not_trusted'); assert.equal(fs.existsSync(shopRoot), false);
  const accepted = publishGeneratedCsv({ spec, sourceFile: source, shopRoot, variables, trustedZero: true, expectedStatus: 'no_data', taskId: 't-2' });
  assert.equal(accepted.status, 'no_data'); assert.deepEqual([...fs.readFileSync(accepted.output_file).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('all four enabled borrowed runners fail closed on a disconnected frozen session', async (t) => {
  const root = temporary(t); const loaded = loadReportMd();
  const page = { url: () => 'https://seller.tiktokshopglobalselling.com/homepage', request: { fetch: async () => { throw new Error('must not call'); } } };
  const browserContext = { pages: () => [page], request: { get: async () => { throw new Error('must not call'); } } };
  const browser = { isConnected: () => false, contexts: () => [browserContext] };
  for (const id of IDS) {
    const outputDir = path.join(root, id); fs.mkdirSync(outputDir);
    const input = { a: {}, b: { seller_page_url: page.url() }, shop: { seller_id: '88001', provider_id: 'cross_border', business_timezone: 'Asia/Manila' },
      reportSpec: loaded.specs[id], providerSpec:loaded.specs[id].providers.cross_border, outputDir,
      startDate: '2026-08-20', endDate: '2026-08-20', advertiserId: '99001', advertiserName: '广告户', businessCenterId: '77001',
      campaignRef: null, productRef: null };
    await assert.rejects(runner(id).run(input, { browser, browserContext }), { code: 'browser_disconnected' }, id);
  }
});
