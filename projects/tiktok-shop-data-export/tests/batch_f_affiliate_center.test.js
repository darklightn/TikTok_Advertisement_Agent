'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { publishRunnerOutput } = require('../scripts/export');
const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');
const { readZipEntries } = require('../scripts/common/xlsx_first_sheet');
const { writeWorkbook } = require('../scripts/common/xlsx_writer');

const runner = require('../scripts/routes/cross_border/affiliate_center_performance');
const AFFILIATE_HEADERS = Array.from({ length: 22 }, (_, index) => `任意表头-${index + 1}`);

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-f-affiliate-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  return root;
}

function workbook(rows = [['达人-A', ...Array(21).fill('1')]], headers = AFFILIATE_HEADERS) {
  return [headers, ['', ...Array(Math.max(0, headers.length - 1)).fill('说明')], ...rows];
}

function fixture(t, options = {}) {
  const root = temporary(t); const outputDir = path.join(root, 'staging'); fs.mkdirSync(outputDir);
  const spec = options.spec || structuredClone(loadReportMd().specs.affiliate_center_performance);
  const file = path.join(root, 'official.xlsx'); writeWorkbook(file, workbook(options.rows, options.headers)); const bytes = fs.readFileSync(file);
  let clicks = 0; let newPages = 0; let closed = 0; let applied = 0;
  const emptyMarker = options.emptyMarker ?? options.empty ?? false;
  const buttonDisabled = options.buttonDisabled ?? options.empty ?? false;
  const button = {
    count: async () => 1, isVisible: async () => true, isEnabled: async () => !buttonDisabled,
    isDisabled: async () => buttonDisabled, click: async () => { clicks += 1; },
  };
  const card = { getByRole: () => button, innerText: async () => emptyMarker ? 'No search results' : 'Details data ₱' };
  const sellerPage = { url: () => 'https://seller.tiktokshopglobalselling.com/home' };
  const affiliateOrigin = spec.providers.cross_border.origin;
  let affiliateUrl = `${affiliateOrigin}/insights/transaction-analysis`; const gotos = [];
  const taskId = options.taskId || '01M0H9KX1F2XS2KV272918HEM7v2';
  const affiliatePage = {
    url: () => affiliateUrl,
    goto: async (url, settings) => { gotos.push({url,settings}); const redirected = new URL(url); const rules=spec.providers.cross_border.official_validation; if (options.pageShopId) redirected.searchParams.set(rules.entry_query_fields.shop_id, options.pageShopId); if (options.pageRegion) redirected.searchParams.set(rules.entry_query_fields.shop_region, options.pageRegion); affiliateUrl = redirected.href; },
    waitForResponse: async (predicate) => { const rules=spec.providers.cross_border.official_validation; const response = { url: () => `${affiliateOrigin}${rules.create_endpoint}`, request: () => ({ method: () => options.createMethod || 'POST' }), status: () => 200, json: async () => options.createBody || ({ code:0, data:{ task_id:taskId } }) }; if (!predicate(response)) throw Object.assign(new Error('create not accepted'), { code:'mock_create_not_accepted' }); return response; },
    waitForRequest: async (predicate) => { const rules=spec.providers.cross_border.official_validation; const request = { method: () => options.exportMethod || 'GET', url: () => { const target=new URL(rules.export_endpoint,affiliateOrigin); target.searchParams.set(rules.entry_query_fields.shop_region,rules.shop_region); target.searchParams.set(rules.seller_query,'88001'); target.searchParams.set(rules.task_query,options.boundTaskId || taskId); return target.href; } }; if (!predicate(request)) throw Object.assign(new Error('export not accepted'), { code:'mock_export_not_accepted' }); return request; },
    waitForEvent: async () => ({ suggestedFilename: () => options.filename || 'untrusted-original-name.bin', createReadStream: async () => require('node:stream').Readable.from(bytes) }),
    close: async () => { closed += 1; },
  };
  const browserContext = { pages: () => [sellerPage, affiliatePage], newPage: async () => { newPages += 1; return affiliatePage; } };
  const browser = { isConnected: () => true, contexts: () => [browserContext] };
  const input = { a:{}, b:{ seller_page_url:sellerPage.url() }, shop:{ seller_id:'88001', provider_id:'cross_border' },
    route:null, reportSpec:spec, providerSpec:spec.providers.cross_border, outputDir,
    startDate:'2026-08-17', endDate:'2026-08-18' };
  const pause = async () => {};
  const dependencies = { browser, browserContext, delay:pause, dismissBlockingOverlay:async()=>{},
    navigateAffiliate:async (_input, _dependencies, rules, origin) => { const target=new URL('/insights/transaction-analysis',origin); target.searchParams.set(rules.entry_query_fields.shop_id,options.pageShopId||'88001'); target.searchParams.set(rules.entry_query_fields.shop_region,options.pageRegion||rules.shop_region); affiliateUrl=target.href; return affiliatePage; },
    resolveDetailsCard:async (_page, _rules, observedPause) => { assert.equal(observedPause, pause); return card; },
    applyDateRange:async (_page, observedCard, start, end) => { assert.equal(observedCard, card); assert.equal(start, input.startDate); assert.equal(end, input.endDate); applied += 1; } };
  return { root, outputDir, spec, input, dependencies, gotos, state:() => ({ clicks, newPages, closed, applied }) };
}

function detailsScenario(sequence) {
  const state = { clicks:0, create:0, download:0 }; const cards = new Map();
  const item = (value) => {
    const card = cards.get(value.key) || {
      key:value.key, getByRole:() => ({ click:async () => { state.clicks += 1; } }),
    };
    cards.set(value.key, card);
    return {
      isVisible:async () => value.visible !== false,
      evaluate:async () => value.hasDate === false || value.hasExport === false ? null : { depth:1, key:value.key },
      locator:(selector) => { assert.equal(selector, 'xpath=..'); return card; },
    };
  };
  let poll = 0;
  const page = {
    getByText:() => {
      const values = sequence[Math.min(poll, sequence.length - 1)]; poll += 1; const candidates = values.map(item);
      return { count:async () => candidates.length, nth:(index) => candidates[index] };
    },
    waitForResponse:async () => { state.create += 1; }, waitForEvent:async () => { state.download += 1; },
  };
  return { page, cards, state };
}

function shortRules() {
  const rules = structuredClone(loadReportMd().specs.affiliate_center_performance.providers.cross_border.official_validation);
  rules.request_timeout_ms = 50;
  rules.page_stability_poll_ms = 1;
  return rules;
}

function runContext(root) {
  return { request_id:'request-f', shop_id:'88001', seller_id:'88001', shop_name:'店', provider_id:'cross_border',
    shop_root:path.join(root, 'shop'), start_date:'2026-08-17', end_date:'2026-08-18', advertiser_id:null };
}

test('real router exposes Affiliate creator detail as report and narrow scope only', () => {
  const loaded = loadReportMd();
  assert.equal(Object.keys(loaded.specs).length, 23);
  assert.deepEqual(resolveReportIds('report:affiliate_center_performance', loaded), ['affiliate_center_performance']);
  assert.deepEqual(resolveReportIds('category:affiliate_attribution', loaded), ['affiliate_center_performance']);
  for (const alias of ['all','default']) assert.throws(() => resolveReportIds(alias, loaded), { code:'report_alias_unknown' });
  assert.equal(loaded.specs.affiliate_center_performance.providers.cross_border.runner, 'scripts/routes/cross_border/affiliate_center_performance.js');
  assert.equal(runner.validateSpec(loaded.specs.affiliate_center_performance, loaded.specs.affiliate_center_performance.providers.cross_border), loaded.specs.affiliate_center_performance);
  const metadata = structuredClone(loaded.specs.affiliate_center_performance);
  metadata.audit_metadata = { owner:'architecture' }; metadata.providers.cross_border.audit_metadata = true; metadata.providers.cross_border.official_validation.audit_metadata = 'ignored';
  assert.equal(runner.validateSpec(metadata, metadata.providers.cross_border, { skillRoot:path.resolve(__dirname, '..') }), metadata);
  const missingRequired = structuredClone(metadata); delete missingRequired.providers.cross_border.official_validation.seller_origin;
  assert.throws(() => runner.validateSpec(missingRequired, missingRequired.providers.cross_border, { skillRoot:path.resolve(__dirname, '..') }), { code:'affiliate_report_spec_invalid' });
  const invalidTransport = structuredClone(loaded.specs.affiliate_center_performance); invalidTransport.providers.cross_border.transport = 'page_context_fetch';
  assert.throws(() => runner.validateSpec(invalidTransport, invalidTransport.providers.cross_border), { code:'affiliate_report_spec_invalid' });
  for (const provider of [
    { origin:'https://affiliate.example', unknown:true },
    { origin:'http://affiliate.example' },
    { origin:'https://affiliate.example/path' },
  ]) {
    const invalidProvider = structuredClone(loaded.specs.affiliate_center_performance);
    invalidProvider.providers.cross_border = provider;
    assert.throws(() => runner.validateSpec(invalidProvider, invalidProvider.providers.cross_border), { code:'affiliate_report_spec_invalid' });
  }
  for (const source of ['^\\d+$', '.*']) { const invalidTaskPattern = structuredClone(loaded.specs.affiliate_center_performance); invalidTaskPattern.providers.cross_border.official_validation.task_id_pattern = source; assert.throws(() => runner.validateSpec(invalidTaskPattern, invalidTaskPattern.providers.cross_border), { code:'affiliate_report_spec_invalid' }); }
  const invalidPattern = structuredClone(loaded.specs.affiliate_center_performance); invalidPattern.providers.cross_border.official_validation.task_id_pattern = '[';
  assert.throws(() => runner.validateSpec(invalidPattern, invalidPattern.providers.cross_border), { code:'affiliate_report_spec_invalid' });
});
test('workbook counts nonempty rows from row 3 without header or business-key coupling', (t) => {
  const root = temporary(t); const spec = loadReportMd().specs.affiliate_center_performance;
  const valid = path.join(root, 'valid.xlsx'); writeWorkbook(valid, workbook());
  assert.equal(runner.inspectWorkbook(fs.readFileSync(valid), spec), 1);
  for (const [name, rows, count] of [
    ['changed-headers', workbook([['row']], ['changed']), 1],
    ['empty-key', workbook([['', ...Array(21).fill('1')]]), 1],
    ['duplicate-key', workbook([['达人-A', ...Array(21).fill('1')], ['达人-A', ...Array(21).fill('2')]]), 2],
    ['missing-description', [AFFILIATE_HEADERS, Array(22).fill(''), ['达人-A', ...Array(21).fill('1')]], 1],
  ]) {
    const file = path.join(root, `${name}.xlsx`); writeWorkbook(file, rows);
    assert.equal(runner.inspectWorkbook(fs.readFileSync(file), spec), count);
  }
  const empty = path.join(root, 'empty.xlsx'); writeWorkbook(empty, [AFFILIATE_HEADERS, Array(22).fill('')]);
  assert.throws(() => runner.inspectWorkbook(fs.readFileSync(empty), spec), { code:'official_data_row_count_mismatch' });
});

test('details card waits through an initial gap or transient duplicate until one structural card is stable', async () => {
  for (const sequence of [
    [[], [{ key:'one' }], [{ key:'one' }]],
    [[{ key:'one' }, { key:'two' }], [{ key:'one' }], [{ key:'one' }]],
  ]) {
    const value = detailsScenario(sequence);
    const card = await runner.resolveDetailsCard(value.page, shortRules(), () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(card, value.cards.get('one'));
    assert.deepEqual(value.state, { clicks:0, create:0, download:0 });
  }
});

test('details card ignores a hidden exact-title duplicate', async () => {
  const value = detailsScenario([
    [{ key:'visible' }, { key:'hidden', visible:false }],
    [{ key:'visible' }, { key:'hidden', visible:false }],
  ]);
  const card = await runner.resolveDetailsCard(value.page, shortRules(), () => new Promise((resolve) => setTimeout(resolve, 1)));
  assert.equal(card, value.cards.get('visible'));
  assert.deepEqual(value.state, { clicks:0, create:0, download:0 });
});

test('details title without a date or unique export control times out as missing without side effects', async () => {
  for (const candidate of [{ key:'missing-date', hasDate:false }, { key:'missing-export', hasExport:false }]) {
    const value = detailsScenario([[candidate]]);
    await assert.rejects(
      runner.resolveDetailsCard(value.page, shortRules(), () => new Promise((resolve) => setTimeout(resolve, 1))),
      { code:'affiliate_details_card_missing' },
    );
    assert.deepEqual(value.state, { clicks:0, create:0, download:0 });
  }
});

test('only persistent distinct visible structural cards are ambiguous and cause no side effects', async () => {
  const value = detailsScenario([[{ key:'one' }, { key:'two' }]]);
  await assert.rejects(
    runner.resolveDetailsCard(value.page, shortRules(), () => new Promise((resolve) => setTimeout(resolve, 1))),
    { code:'affiliate_details_card_ambiguous' },
  );
  assert.deepEqual(value.state, { clicks:0, create:0, download:0 });
});

test('runner accepts alphanumeric create task, binds exact export request, and publishes official bytes', async (t) => {
  const value = fixture(t); const result = await runner.run(value.input, value.dependencies);
  assert.equal(result.status, 'success'); assert.equal(result.task_id, '01M0H9KX1F2XS2KV272918HEM7v2'); assert.equal(result.data_row_count, 1);
  const published = publishRunnerOutput(result, value.spec, runContext(value.root), value.outputDir);
  assert.equal(published.status, 'success');
  assert.equal(published.files[0], path.join(value.root, 'shop', '店铺数据', '联盟达人明细', '2026-08-17_至_2026-08-18.xlsx'));
  assert.equal(published.files.length, 1); assert.equal(published.currency_embedded, true);
  const custom = readZipEntries(fs.readFileSync(published.files[0])).get('docProps/custom.xml').toString('utf8');
  assert.match(custom, /name="Currency"[^>]*><vt:lpwstr>PHP<\/vt:lpwstr>/u);
  assert.match(custom, /name="CurrencySymbol"[^>]*><vt:lpwstr>₱<\/vt:lpwstr>/u);
  assert.equal(fs.existsSync(`${published.files[0]}.currency.json`), false);
  assert.deepEqual(value.state(), { clicks:1, newPages:0, closed:0, applied:1 });
});

test('runner navigation contract and create task path are driven by MD', async (t) => {
  const spec=structuredClone(loadReportMd().specs.affiliate_center_performance); const rules=spec.providers.cross_border.official_validation;
  spec.providers.cross_border.origin='https://sentinel-affiliate.example';
  Object.assign(rules,{seller_origin:'https://seller.tiktokshopglobalselling.com',navigation_steps:['^联盟$','^数据分析$','^表现$'],entry_query_fields:{shop_id:'sentinel_shop',shop_region:'sentinel_region'},shop_region:'ZZ',create_endpoint:'/sentinel-create',export_endpoint:'/sentinel-export',seller_query:'sentinel_seller',task_query:'sentinel_task',response_paths:{create_task_id:['sentinel','id']},request_timeout_ms:4321});
  const taskId='01M0H9KX1F2XS2KV272918HEM7v2'; const value=fixture(t,{spec,createBody:{code:0,sentinel:{id:taskId}}}); let observed;
  value.dependencies.navigateAffiliate=async (_input,_dependencies,observedRules,origin)=>{observed={rules:observedRules,origin};const target=new URL('/observed',origin);target.searchParams.set(observedRules.entry_query_fields.shop_id,'88001');target.searchParams.set(observedRules.entry_query_fields.shop_region,'ZZ');value.dependencies.browserContext.pages().at(-1).goto(target.href);return value.dependencies.browserContext.pages().at(-1);};
  const result=await runner.run(value.input,value.dependencies);
  assert.equal(result.task_id,taskId); assert.equal(observed.origin,spec.providers.cross_border.origin); assert.deepEqual(observed.rules.navigation_steps,['^联盟$','^数据分析$','^表现$']); assert.equal(observed.rules.request_timeout_ms,4321);
});

test('Affiliate enters through Seller left navigation and deduplicates nested labels sharing one link', async () => {
  const spec=loadReportMd().specs.affiliate_center_performance;const rules=spec.providers.cross_border.official_validation;const origin=spec.providers.cross_border.origin;const clicks=[];
  const locatorFor=(label,count=1)=>({count:async()=>count,nth:()=>({isVisible:async()=>true,locator:()=>({count:async()=>1,click:async()=>{clicks.push(label);},evaluate:async(callback)=>{if(String(callback).includes('element.click')){clicks.push(label);return undefined;}return 'shared-ancestor';}})})});
  const seller={url:()=>`${rules.seller_origin}/home`,getByText:()=>locatorFor('联盟',2)};
  const target=new URL('/insights/transaction-analysis',origin);target.searchParams.set(rules.entry_query_fields.shop_id,'88001');target.searchParams.set(rules.entry_query_fields.shop_region,rules.shop_region);
  let step=0;const affiliate={url:()=>target.href,getByText:()=>locatorFor(++step===1?'数据分析':'表现')};
  const browserContext={pages:()=>[seller,affiliate]};const input={shop:{seller_id:'88001'}};
  let overlayChecks=0;const page=await runner.navigateAffiliate(input,{browserContext,dismissBlockingOverlay:async()=>{overlayChecks+=1;}},rules,origin,async()=>{});
  assert.equal(page,affiliate);assert.equal(overlayChecks,4);assert.deepEqual(clicks,['联盟','数据分析','表现']);
});

test('runner rejects unsafe task IDs independently of the MD pattern', async (t) => {
  const value=fixture(t,{taskId:'unsafe_id'}); await assert.rejects(runner.run(value.input,value.dependencies),{code:'affiliate_export_task_changed'});
});

test('invalid Affiliate execution rules fail through run before page I/O', async (t) => {
  const spec=structuredClone(loadReportMd().specs.affiliate_center_performance); spec.providers.cross_border.official_validation.task_id_pattern='.*';
  const value=fixture(t,{spec}); await assert.rejects(runner.run(value.input,value.dependencies),{code:'affiliate_report_spec_invalid'});
  assert.equal(value.gotos.length,0); assert.equal(value.state().clicks,0);
});

test('runner rejects a provider missing from the report spec before page I/O', async (t) => {
  const value=fixture(t); value.input.shop.provider_id='local';
  await assert.rejects(runner.run(value.input,value.dependencies),{code:'report_provider_unsupported'});
  assert.equal(value.gotos.length,0); assert.equal(value.state().clicks,0);
});

test('runner rejects a download request bound to a different task ID', async (t) => {
  const value = fixture(t, { boundTaskId:'differentTask' });
  await assert.rejects(runner.run(value.input, value.dependencies), { code:'affiliate_export_task_binding_mismatch' });
  assert.equal(value.state().clicks, 1); assert.equal(fs.readdirSync(value.outputDir).length, 0);
});

test('page shop and region redirects fail as fatal identity drift before export click', async (t) => {
  for (const options of [{ pageShopId:'99001' }, { pageRegion:'US' }]) {
    const value = fixture(t, options);
    await assert.rejects(runner.run(value.input, value.dependencies), { code:'result_shop_identity_mismatch' });
    assert.equal(value.state().clicks, 0); assert.equal(fs.readdirSync(value.outputDir).length, 0);
  }
});

test('create accepts only POST and export accepts only GET', async (t) => {
  for (const [options, code] of [[{ createMethod:'GET' }, 'mock_create_not_accepted'], [{ exportMethod:'POST' }, 'mock_export_not_accepted']]) {
    const value = fixture(t, options);
    await assert.rejects(runner.run(value.input, value.dependencies), { code });
    assert.equal(fs.readdirSync(value.outputDir).length, 0);
  }
});

test('an unavailable requested date fails before any export click', async (t) => {
  const value = fixture(t); value.dependencies.applyDateRange = async () => { throw Object.assign(new Error('unavailable'), { code:'affiliate_date_range_not_selectable' }); };
  await assert.rejects(runner.run(value.input, value.dependencies), { code:'affiliate_date_range_not_selectable' });
  assert.equal(value.state().clicks, 0); assert.equal(fs.readdirSync(value.outputDir).length, 0);
});

test('details-card empty state without an integer official zero signal fails closed', async (t) => {
  const value = fixture(t, { empty:true });
  await assert.rejects(runner.run(value.input, value.dependencies), { code:'affiliate_official_zero_signal_unavailable' });
  assert.equal(fs.readdirSync(value.outputDir).length, 0);
  assert.deepEqual(value.state(), { clicks:0, newPages:0, closed:0, applied:1 });
});

test('empty marker with an enabled export button fails closed before click', async (t) => {
  const value = fixture(t, { emptyMarker:true, buttonDisabled:false });
  await assert.rejects(runner.run(value.input, value.dependencies), { code:'affiliate_empty_state_contract_mismatch' });
  assert.equal(value.state().clicks, 0); assert.equal(fs.readdirSync(value.outputDir).length, 0);
});
