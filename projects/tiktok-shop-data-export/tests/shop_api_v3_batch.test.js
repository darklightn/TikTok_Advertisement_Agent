'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');
const { publishRunnerResult } = require('../scripts/export');
const daily = require('../scripts/routes/cross_border/shop_product_daily_performance');
const video = require('../scripts/routes/cross_border/shop_video_performance');
const growth = require('../scripts/routes/cross_border/shop_product_growth_opportunity_snapshot');
const commercial = require('../scripts/routes/cross_border/shop_product_commercial_status_snapshot');
const { validateReportSpec } = require('../scripts/common/md-spec-validator');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');

const SELLER = '7494671404273272171';
function response(url, body, status = 200) {
  return { url: () => url, status: () => status, body: async () => Buffer.from(JSON.stringify(body)) };
}
function harness(fetch) {
  const page = { url: () => 'https://seller.tiktokshopglobalselling.com/homepage', ...(fetch ? { request: { fetch } } : {}) };
  const context = { pages: () => [page] };
  const browser = { isConnected: () => true, contexts: () => [context] };
  return { page, context, browser, dependencies: { browser, browserContext: context, skillRoot: path.resolve(__dirname, '..') } };
}
function input(spec, outputDir, dates = {}) {
  return {
    reportSpec: spec, outputDir, startDate: dates.start || '2026-08-20', endDate: dates.end || '2026-08-20',
    b: { seller_page_url: 'https://seller.tiktokshopglobalselling.com/homepage' },
    shop: { seller_id: SELLER, provider_id: 'cross_border' },
    ...(spec.providers?.cross_border ? { providerSpec: spec.providers.cross_border } : {}),
  };
}
function publishContext(shopRoot, dates = {}) {
  return { request_id: 'batch-s', shop_root: shopRoot, shop_name: 'Shop', shop_id: SELLER, seller_id: SELLER, provider_id: 'cross_border', start_date: dates.start || '2026-08-20', end_date: dates.end || '2026-08-20' };
}
function videoBody(rows, total = rows.length, totalPages = total ? 1 : 0, dates = {}) { return { code:0, message:'success', data:{ segments:[{ timed_lists:[{ start:dates.start||'2026-08-20T00:00:00', end:dates.end||'2026-08-21T00:00:00', ...(rows === null ? {} : { stats:rows }) }], list_control:{ next_pagination:{ total, total_page:totalPages } } }] } }; }

test('real router exposes four migrated shop API reports and still rejects broad aliases', () => {
  const loaded = loadReportMd();
  for (const reportId of ['shop_product_daily_performance', 'shop_video_performance', 'shop_product_growth_opportunity_snapshot', 'shop_product_commercial_status_snapshot']) {
    assert.equal(resolveReportIds(`report:${reportId}`, loaded)[0], reportId);
  }
  for (const reportId of ['shop_video_performance', 'shop_product_growth_opportunity_snapshot', 'shop_product_commercial_status_snapshot']) {
    const spec = loaded.specs[reportId];
    assert.equal(spec.runner, undefined);
    assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']);
    assert.equal(spec.providers.cross_border.retry_policy, undefined);
    const sourceRunner = fs.readFileSync(path.join(__dirname, '..', spec.providers.cross_border.runner), 'utf8');
    assert.match(sourceRunner, /providerSpec/u);
    const common = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'routes', 'common', `${reportId}_v3.js`), 'utf8');
    assert.doesNotMatch(common, /\brun\b|endpoint_path|response_origin|\.request\.|pagination\s*(?:loop|decision)|provider_id/u);
  }
  for (const alias of ['all', 'default']) assert.throws(() => resolveReportIds(alias, loaded), { code: 'report_alias_unknown' });
  const invalid = structuredClone(loaded.specs.shop_product_daily_performance);
  invalid.logical_tables[1].logical_table = invalid.logical_tables[0].logical_table;
  assert.throws(() => validateReportSpec(invalid, { skillRoot: path.resolve(__dirname, '..') }), { code: 'report_spec_api_table_invalid' });
  for (const responseOrigin of ['http://api.example', 'https://api.example/path', 'https://api.example?x=1']) {
    const invalidOrigin = structuredClone(loaded.specs.shop_product_daily_performance); invalidOrigin.providers.cross_border.response_origin = responseOrigin;
    assert.throws(() => daily.validateSpec(invalidOrigin, { skillRoot:path.resolve(__dirname, '..') }), { code:'shop_product_daily_spec_invalid' });
  }
  const invalidTransport = structuredClone(loaded.specs.shop_product_daily_performance); invalidTransport.providers.cross_border.transport = 'official_ui_download';
  assert.throws(() => daily.validateSpec(invalidTransport, { skillRoot:path.resolve(__dirname, '..') }), { code:'shop_product_daily_spec_invalid' });
  const metadata = structuredClone(loaded.specs.shop_product_daily_performance);
  metadata.audit_metadata = { owner:'architecture' }; metadata.providers.cross_border.audit_metadata = true; metadata.providers.cross_border.api_contract.audit_metadata = 'ignored';
  assert.equal(daily.validateSpec(metadata, { skillRoot:path.resolve(__dirname, '..') }), metadata);
  const missingRequired = structuredClone(metadata); delete missingRequired.providers.cross_border.api_contract.pagination_fields;
  assert.throws(() => daily.validateSpec(missingRequired, { skillRoot:path.resolve(__dirname, '..') }), { code:'shop_product_daily_spec_invalid' });
});

test('product performance sends one requested range and publishes one file per logical table', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-daily-v3-')); const loaded = loadReportMd(); const spec = loaded.specs.shop_product_daily_performance;
  const live = harness(); let calls = 0;
  const dates = { start:'2026-08-01', end:'2026-08-31' };
  const result = await daily.run(input(spec, path.join(root, 'stage'), dates), { ...live.dependencies, seedUrl: 'https://api16-normal-sg.tiktokshopglobalselling.com/api/v3/insights/seller/ttp/product/list', request: async (_page, request) => {
    calls += 1; const id = '100';
    assert.deepEqual(request.body.request.time_descriptor, { start:'2026-08-01', end:'2026-09-01' });
    return { http_status: 200, body: { code: 0, data: { items: [{ meta: { product_id: id, title: 'P' }, stats_v3: { gmv: 1 } }], list_control: { next_pagination: { total: 1, has_more: false } } } } };
  } });
  assert.equal(calls, 5); assert.equal(result.status, 'success'); assert.equal(result.artifacts.length, 5);
  const published = publishRunnerResult(result, spec, publishContext(path.join(root, 'shop'), dates), path.join(root, 'stage'));
  assert.equal(published.status, 'success'); assert.equal(published.files.length, 5);
  for (const file of published.files) { assert.equal(fs.existsSync(file), true); assert.match(file, /2026-08-01_至_2026-08-31\.xlsx$/u); }
});

test('daily authoritative zero creates five trusted empty tables without querying other channels', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-daily-zero-v3-')); const spec = loadReportMd().specs.shop_product_daily_performance; const live = harness(); let calls = 0;
  const result = await daily.run(input(spec, path.join(root, 'stage')), { ...live.dependencies, seedUrl: 'https://api16-normal-sg.tiktokshopglobalselling.com/api/v3/insights/seller/ttp/product/list', request: async () => { calls += 1; return { http_status: 200, body: { code: 0, data: { list_control: { next_pagination: { total: 0, has_more: false } } } } }; } });
  assert.equal(calls, 1); assert.equal(result.status, 'no_data'); assert.equal(result.artifacts.length, 5); assert.ok(result.artifacts.every((item) => item.row_count === 0));
});

test('daily source and API failures keep precise reasons and publish nothing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-daily-fail-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = loadReportMd().specs.shop_product_daily_performance;
  const timeout = Object.assign(new Error('capture timeout'), { name: 'TimeoutError' });
  await assert.rejects(() => daily.sourceUrl({ origin: 'https://seller.tiktokshopglobalselling.com', page: {
    url: () => 'https://seller.tiktokshopglobalselling.com/homepage',
    waitForRequest: async () => { throw timeout; }, goto: async () => {},
  } }, spec.providers.cross_border, {}), { code: 'shop_product_daily_source_capture_timeout' });
  await assert.rejects(() => daily.sourceUrl({ origin: 'https://seller.tiktokshopglobalselling.com', page: {
    waitForRequest: async () => ({ url: () => 'https://example.invalid/list' }), goto: async () => { throw new Error('navigation'); },
    url: () => 'https://seller.tiktokshopglobalselling.com/homepage',
  } }, spec.providers.cross_border, {}), { code: 'shop_product_daily_navigation_error' });

  const cases = [
    ['transport', async () => { throw Object.assign(new Error('transport'), { code: 'ECONNRESET' }); }, 'shop_product_daily_transport_error'],
    ['http', async () => ({ http_status: 503, body: null }), 'shop_product_daily_http_error'],
    ['challenge', async () => ({ http_status: 200, body: { code: 10000, 'bdturing-verify': { type: 'verify' } } }), 'shop_product_daily_api_challenge'],
    ['shape', async () => ({ http_status: 200, body: null }), 'shop_product_daily_shape_mismatch'],
    ['business', async () => ({ http_status: 200, body: { code: 7 } }), 'shop_product_daily_api_error'],
  ];
  for (const [name, request, code] of cases) {
    const stage = path.join(root, name); const live = harness();
    await assert.rejects(() => daily.run(input(spec, stage), {
      ...live.dependencies,
      seedUrl: 'https://api16-normal-sg.tiktokshopglobalselling.com/api/v3/insights/seller/ttp/product/list',
      request,
    }), { code });
    assert.equal(fs.existsSync(stage), false);
  }
  const disconnected = harness(); let connected = true;
  const disconnectedBrowser = { isConnected: () => connected, contexts: () => [disconnected.context] };
  await assert.rejects(() => daily.run(input(spec, path.join(root, 'disconnected')), {
    ...disconnected.dependencies, browser: disconnectedBrowser,
    seedUrl: 'https://api16-normal-sg.tiktokshopglobalselling.com/api/v3/insights/seller/ttp/product/list?signed=redacted',
    request: async () => { connected = false; throw new Error('transport'); },
  }), { code: 'browser_disconnected' });
  assert.equal(fs.existsSync(path.join(root, 'disconnected')), false);
});

test('daily reloads the active entry and uses page-context fetch for planned payloads', async () => {
  const spec = loadReportMd().specs.shop_product_daily_performance;
  let reloads = 0; let gotos = 0; let evaluated;
  const page = {
    url: () => 'https://seller.tiktokshopglobalselling.com/compass/product-analysis?from=menu',
    waitForRequest: async () => ({ url: () => 'https://api16-normal-sg.tiktokshopglobalselling.com/api/v3/insights/seller/ttp/product/list?signed=redacted' }),
    reload: async () => { reloads += 1; },
    goto: async () => { gotos += 1; },
    evaluate: async (_callback, value) => {
      evaluated = value;
      return { http_status: 200, body: { code: 0, data: { list_control: { next_pagination: { total: 0, has_more: false } } } } };
    },
  };
  const browser = { isConnected: () => true };
  const live = { browser, page, origin: 'https://seller.tiktokshopglobalselling.com', sellerId: SELLER };
  const endpoint = await daily.sourceUrl(live, spec.providers.cross_border, {});
  const contract = spec.providers.cross_border.api_contract;
  const result = await daily.collect(live, spec, spec.providers.cross_border, '2026-08-15', '2026-08-31', contract.channels[0], {}, endpoint);
  assert.equal(reloads, 1); assert.equal(gotos, 0); assert.equal(result.total, 0);
  assert.equal(new URL(evaluated.url).pathname, spec.providers.cross_border.endpoint_path);
  assert.deepEqual(evaluated.body, daily.payload(contract, '2026-08-15', '2026-08-31', contract.channels[0], 0));
  assert.equal(evaluated.timeoutMs, spec.providers.cross_border.request_timeout_ms);
});

test('daily source capture uses the selected provider MD entry endpoint and timeout', async () => {
  const rules = structuredClone(loadReportMd().specs.shop_product_daily_performance.providers.cross_border);
  rules.entry_path = '/sentinel-product-entry'; rules.endpoint_path = '/sentinel-product-list'; rules.request_timeout_ms = 123;
  let waited; let navigated;
  const page = {
    url: () => 'https://seller.tiktokshopglobalselling.com/homepage',
    waitForRequest: async (predicate, options) => {
      waited = options;
      assert.equal(predicate({ method: () => 'POST', url: () => `${rules.response_origin}${rules.endpoint_path}` }), true);
      assert.equal(predicate({ method: () => 'POST', url: () => `https://evil.example${rules.endpoint_path}` }), false);
      assert.equal(predicate({ method: () => 'POST', url: () => `https://seller-ph.tiktok.com${rules.endpoint_path}` }), false);
      return { url: () => `${rules.response_origin}${rules.endpoint_path}` };
    },
    goto: async (url, options) => { navigated = { url, options }; },
  };
  const endpoint = await daily.sourceUrl({ page, origin: 'https://seller.tiktokshopglobalselling.com' }, rules, {});
  assert.equal(new URL(navigated.url).pathname, rules.entry_path);
  assert.equal(navigated.options.timeout, rules.request_timeout_ms); assert.equal(waited.timeout, rules.request_timeout_ms);
  assert.equal(new URL(endpoint).pathname, rules.endpoint_path);
  assert.equal(new URL(endpoint).origin, rules.response_origin);
  for (const origin of ['https://evil.example', 'https://seller-ph.tiktok.com']) {
    await assert.rejects(() => daily.sourceUrl({}, rules, { seedUrl:`${origin}${rules.endpoint_path}` }), { code:'shop_product_daily_source_origin_mismatch' });
  }
});

test('daily page-context transport has a Node-side hard timeout before staging', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-daily-timeout-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = structuredClone(loadReportMd().specs.shop_product_daily_performance);
  spec.providers.cross_border.request_timeout_ms = 20;
  const live = harness();
  live.page.evaluate = async () => new Promise(() => {});
  const stage = path.join(root, 'stage'); const started = Date.now();
  await assert.rejects(() => daily.run(input(spec, stage), {
    ...live.dependencies,
    seedUrl: 'https://api16-normal-sg.tiktokshopglobalselling.com/api/v3/insights/seller/ttp/product/list?signed=redacted',
  }), { code: 'shop_product_daily_transport_timeout' });
  assert.ok(Date.now() - started < 1000);
  assert.equal(fs.existsSync(stage), false);
});

test('daily pagination collects the complete stable product set', async () => {
  const spec = loadReportMd().specs.shop_product_daily_performance; const fixture = harness(); let calls = 0;
  const live = { browser: fixture.browser, context: fixture.context, page: fixture.page, origin: 'https://seller.tiktokshopglobalselling.com', sellerId: SELLER };
  const collected = await daily.collect(live, spec, spec.providers.cross_border, '2026-08-20', '2026-08-31', spec.providers.cross_border.api_contract.channels[0], {
    request: async (_page, request) => {
      const page = request.body.request.list_control.pagination.page; calls += 1;
      return { http_status: 200, body: { code: 0, data: {
        items: [{ meta: { product_id: String(page + 1) } }],
        list_control: { next_pagination: { total: 2, has_more: page === 0 } },
      } } };
    },
  }, 'https://api16-normal-sg.tiktokshopglobalselling.com/api/v3/insights/seller/ttp/product/list');
  assert.equal(calls, 2); assert.equal(collected.total, 2);
  assert.deepEqual(collected.items.map((item) => item.meta.product_id), ['1', '2']);
});

test('video and growth enforce identities, totals, and trusted zero', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-simple-v3-')); const loaded = loadReportMd(); const live = harness();
  const videoLive=harness(async(url)=>response(url,{ code: 0, data: { segments: [{ timed_lists: [{ start: '2026-08-20T00:00:00', end: '2026-08-21T00:00:00', stats: [{ shop_id: SELLER, video_meta: { id: '88' }, revenue: 1 }] }], list_control: { next_pagination: { total: 1, total_page: 1 } } }] } }));
  const videoResult = await video.run(input(loaded.specs.shop_video_performance, path.join(root, 'video')), videoLive.dependencies);
  assert.equal(videoResult.status, 'success'); assert.equal(videoResult.row_count, 1);
  const videoZeroLive=harness(async(url)=>response(url,{ code: 0, data: { segments: [{ timed_lists: [{ start: '2026-08-20', end: '2026-08-21' }], list_control: { next_pagination: { total: 0, total_page: 0 } } }] } }));
  const videoZero = await video.run(input(loaded.specs.shop_video_performance, path.join(root, 'video-zero')), videoZeroLive.dependencies);
  assert.equal(videoZero.status, 'no_data'); assert.equal(videoZero.row_count, 0);
  const growthSpec=loaded.specs.shop_product_growth_opportunity_snapshot;const growthProvider=growthSpec.providers.cross_border;
  const growthZeroLive=harness(async(url)=>response(url,{code:0,data:{products:[],total:0}}));
  const growthResult = await growth.run(input(growthSpec, path.join(root, 'growth')), growthZeroLive.dependencies);
  assert.equal(growthResult.status, 'no_data'); assert.equal(growthResult.row_count, 0);
  const growthSuccessLive=harness(async(url)=>response(url,{code:0,data:{products:[{product_id:'99',task:{status:1}}],total:1}}));
  const growthSuccess = await growth.run(input(growthSpec, path.join(root, 'growth-success')), growthSuccessLive.dependencies);
  assert.equal(growthSuccess.status, 'success'); assert.equal(growthSuccess.row_count, 1);
  assert.equal(growthProvider.response_origin,'https://seller.tiktokshopglobalselling.com');
  const badVideoLive=harness(async(url)=>response(url,{ code: 0, data: { segments: [{ timed_lists: [{ start: '2026-08-20', end: '2026-08-21', stats: [{ shop_id: '9', video_meta: { id: '1' } }] }], list_control: { next_pagination: { total: 1, total_page: 1 } } }] } }));
  await assert.rejects(() => video.run(input(loaded.specs.shop_video_performance, path.join(root, 'bad')), badVideoLive.dependencies), { code: 'shop_video_identity_mismatch' });
});

test('video provider metadata and request shape constants are driven by selected MD', async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shop-video-sentinel-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const spec=structuredClone(loadReportMd().specs.shop_video_performance);const provider=spec.providers.cross_border;const contract=provider.api_contract;
  spec.metadata=true;provider.metadata={ignored:true};contract.metadata=true;contract.filter.future_filter='preserved';contract.rules.push({future_rule:true});contract.stats_types.push(999);contract.request_shape={root:'sentinel_root',params:'sentinel_params',time:'sentinel_time',start:'sentinel_start',end:'sentinel_end',timezone:'sentinel_timezone',granularity_field:'sentinel_granularity_field',granularity:'sentinel_granularity',scenario_field:'sentinel_scenario_field',scenario:77,filter:'sentinel_filter',list_control:'sentinel_control',rules:'sentinel_rules',pagination:'sentinel_pagination',size:'sentinel_size',page:'sentinel_page',stats_types:'sentinel_stats',version_field:'sentinel_version_field',version:9};
  video.validateSpec(spec,provider);let observed;const live=harness(async(url,options)=>{observed={url,options};return response(url,videoBody([]));});const result=await video.run(input(spec,path.join(root,'stage')),live.dependencies);assert.equal(result.status,'no_data');
  const params=observed.options.data.sentinel_root.sentinel_params[0];assert.deepEqual(params.sentinel_time,{sentinel_start:'2026-08-20',sentinel_end:'2026-08-21',sentinel_timezone:28800,sentinel_granularity_field:'sentinel_granularity',sentinel_scenario_field:77});assert.equal(params.sentinel_filter.future_filter,'preserved');assert.deepEqual(params.sentinel_control.sentinel_rules.at(-1),{future_rule:true});assert.equal(params.sentinel_control.sentinel_pagination.sentinel_page,0);assert.equal(params.sentinel_control.sentinel_pagination.sentinel_size,10);assert.equal(params.sentinel_stats.at(-1),999);assert.equal(observed.options.data.sentinel_version_field,9);
  const invalid=structuredClone(spec);delete invalid.providers.cross_border.api_contract.request_shape.page;assert.throws(()=>video.validateSpec(invalid,invalid.providers.cross_border),{code:'shop_video_spec_invalid'});
});

test('video completes stable zero-based pagination and rejects incomplete or untrusted records', async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shop-video-pages-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const base=loadReportMd().specs.shop_video_performance;let execution=0;
  async function execute(factory,spec=base){execution+=1;const provider=spec.providers.cross_border;const shape=provider.api_contract.request_shape;const live=harness(async(url,options)=>{const page=options.data[shape.root][shape.params][0][shape.list_control][shape.pagination][shape.page];return response(url,factory(page));});return video.run(input(spec,path.join(root,`stage-${execution}`)),live.dependencies);}
  const success=await execute((page)=>videoBody([{shop_id:SELLER,video_meta:{id:String(page+1),title:`Video ${page+1}`},revenue:page+1}],2,2));assert.equal(success.status,'success');assert.equal(success.row_count,2);const sheet=readFirstWorksheet(fs.readFileSync(success.output_file));assert.deepEqual(sheet.headers,base.headers);assert.equal(JSON.parse(sheet.rows[1][1]).title,'Video 1');assert.equal(JSON.parse(sheet.rows[1][2]).revenue,1);
  const zero=await execute(()=>videoBody([],0,0));assert.equal(zero.status,'no_data');assert.equal(zero.row_count,0);const zeroSheet=readFirstWorksheet(fs.readFileSync(zero.output_file));assert.equal(zeroSheet.rows.length,1);
  for(const [name,factory,code] of [
    ['total-drift',(page)=>videoBody([{shop_id:SELLER,video_meta:{id:String(page+1)}}],page?3:2,2),'shop_video_pagination_incomplete'],
    ['pages-drift',(page)=>videoBody([{shop_id:SELLER,video_meta:{id:String(page+1)}}],2,page?3:2),'shop_video_pagination_incomplete'],
    ['duplicate',()=>videoBody([{shop_id:SELLER,video_meta:{id:'1'}}],2,2),'shop_video_pagination_incomplete'],
    ['identity',()=>videoBody([{shop_id:'9',video_meta:{id:'1'}}],1,1),'shop_video_identity_mismatch'],
    ['empty-id',()=>videoBody([{shop_id:SELLER,video_meta:{id:''}}],1,1),'shop_video_pagination_incomplete'],
    ['date',()=>videoBody([{shop_id:SELLER,video_meta:{id:'1'}}],1,1,{start:'2026-08-19',end:'2026-08-21'}),'shop_video_date_mismatch'],
    ['incomplete',()=>videoBody([{shop_id:SELLER,video_meta:{id:'1'}}],2,1),'shop_video_pagination_incomplete'],
  ])await assert.rejects(()=>execute(factory),{code},name);
  const limited=structuredClone(base);limited.providers.cross_border.api_contract.max_pages=1;await assert.rejects(()=>execute((page)=>videoBody([{shop_id:SELLER,video_meta:{id:String(page+1)}}],2,2),limited),{code:'shop_video_pagination_incomplete'});
  await assert.rejects(()=>execute(()=>videoBody([],0,1)),{code:'shop_video_pagination_incomplete'});
});

test('video accepts only exact official final URL and both frozen seller query echoes', async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shop-video-origin-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const spec=loadReportMd().specs.shop_video_performance;const provider=spec.providers.cross_border;let execution=0;
  async function execute(mutate,disconnect=false){execution+=1;let connected=true;const page={url:()=>`${provider.response_origin}/homepage`,request:{fetch:async(url)=>{const final=new URL(url);mutate?.(final);if(disconnect)connected=false;return response(final.href,videoBody([]));}}};const context={pages:()=>[page]};const browser={isConnected:()=>connected,contexts:()=>[context]};return video.run(input(spec,path.join(root,`stage-${execution}`)),{browser,browserContext:context,skillRoot:path.resolve(__dirname,'..')});}
  await assert.doesNotReject(()=>execute());for(const origin of ['https://evil.example','https://seller-ph.tiktok.com'])await assert.rejects(()=>execute((url)=>{const changed=new URL(origin);url.protocol=changed.protocol;url.host=changed.host;}),{code:'seller_origin_mismatch'});
  await assert.rejects(()=>execute((url)=>{url.pathname='/wrong';}),{code:'seller_origin_mismatch'});
  for(const name of provider.api_contract.search_params.seller_query_names){await assert.rejects(()=>execute((url)=>url.searchParams.delete(name)),{code:'provider_binding_invalid'});await assert.rejects(()=>execute((url)=>url.searchParams.set(name,'9')),{code:'provider_binding_invalid'});}
  await assert.rejects(()=>execute(null,true),{code:'browser_disconnected'});
});

test('growth provider rules drive complete one-based pagination and reject drift or duplicate ids', async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shop-growth-pages-v3-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const spec=structuredClone(loadReportMd().specs.shop_product_growth_opportunity_snapshot);const provider=spec.providers.cross_border;
  provider.api_contract.page_size=1;provider.audit_metadata=true;provider.api_contract.payload_metadata={ignored:true};
  growth.validateSpec(spec,provider);
  const seen=[];const live=harness(async(url,options)=>{seen.push(options.data);const pageNumber=options.data[provider.api_contract.request_fields.page];return response(url,{code:0,data:{products:[{product_id:String(pageNumber)}],total:2}});});
  const result=await growth.run(input(spec,path.join(root,'success')),live.dependencies);
  assert.equal(result.status,'success');assert.equal(result.row_count,2);assert.deepEqual(seen.map((body)=>body[provider.api_contract.request_fields.page]),[1,2]);
  for(const [name,pages] of [
    ['drift',[{products:[{product_id:'1'}],total:2},{products:[{product_id:'2'}],total:3}]],
    ['duplicate',[{products:[{product_id:'1'}],total:2},{products:[{product_id:'1'}],total:2}]],
  ]){let index=0;const failing=harness(async(url)=>response(url,{code:0,data:pages[index++]}));await assert.rejects(()=>growth.run(input(spec,path.join(root,name)),failing.dependencies),{code:'shop_product_growth_pagination_incomplete'});}
  const invalid=structuredClone(spec);delete invalid.providers.cross_border.api_contract.total_path;
  assert.throws(()=>growth.validateSpec(invalid,invalid.providers.cross_border),{code:'shop_product_growth_spec_invalid'});
});

test('growth accepts only the selected official response origin and preserves disconnect fatal priority', async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shop-growth-origin-v3-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const spec=loadReportMd().specs.shop_product_growth_opportunity_snapshot;const provider=spec.providers.cross_border;
  for(const origin of ['https://evil.example','https://seller-ph.tiktok.com']){const live=harness(async()=>response(`${origin}${provider.api_contract.endpoint_path}`,{code:0,data:{products:[],total:0}}));await assert.rejects(()=>growth.run(input(spec,path.join(root,new URL(origin).hostname)),live.dependencies),{code:'seller_origin_mismatch'});}
  let connected=true;let live;live=harness(async()=>{connected=false;throw new Error('transport');});const browser={isConnected:()=>connected,contexts:()=>[live.context]};
  await assert.rejects(()=>growth.run(input(spec,path.join(root,'disconnect')),{...live.dependencies,browser}),{code:'browser_disconnected'});
});

test('commercial status provider runner preserves seed query, paginates four tabs, and publishes both tables', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-commercial-v3-'));
  const spec = structuredClone(loadReportMd().specs.shop_product_commercial_status_snapshot);
  spec.audit_metadata = { future: true }; spec.providers.cross_border.audit_metadata = true; spec.providers.cross_border.api_contract.query_constants.future_constant = 'kept';
  commercial.validateSpec(spec, spec.providers.cross_border, { skillRoot:path.resolve(__dirname, '..') });
  const provider = spec.providers.cross_border, contract = provider.api_contract;
  const seed = new URL(`${provider.response_origin}${contract.endpoint_path}`);
  seed.searchParams.set('seller_id', SELLER); seed.searchParams.set('oec_seller_id', SELLER); seed.searchParams.set('dynamic_token', 'preserved');
  let gotoCalls = 0; const requested = [];
  const page = {
    url: () => 'https://seller.tiktokshopglobalselling.com/previous-report',
    waitForResponse: async (predicate) => { const item = { url:() => seed.href }; assert.equal(predicate(item), true); return item; },
    goto: async (url) => { gotoCalls += 1; assert.equal(url, 'https://seller.tiktokshopglobalselling.com/product/manage'); },
    evaluate: async (_fn, { requestUrl:url }) => {
      requested.push(url); const query = new URL(url).searchParams; const tab = query.get('tab_id'), pageNumber = Number(query.get('page_number'));
      const products = tab === '1' && pageNumber === 1 ? [{ product_id:'101', product_future:'kept', total_sku_count:1, skus:[{ id:'201', sku_future:'kept' }] }] : [];
      const body = { code:0, data:{ total_product_count:products.length, page_number:pageNumber, page_size:50, ...(products.length ? { products } : {}) } };
      return { final_url:url, http_status:200, body };
    },
  };
  const context = { pages:() => [page] }, browser = { isConnected:() => true, contexts:() => [context] };
  const result = await commercial.run(input(spec, path.join(root, 'stage')), { browser, browserContext:context, skillRoot:path.resolve(__dirname, '..') });
  assert.equal(gotoCalls, 1); assert.equal(requested.length, 4); assert.equal(result.status, 'success'); assert.deepEqual(result.artifacts.map((item) => item.row_count), [1, 1]);
  for (const url of requested) { const query = new URL(url).searchParams; assert.equal(query.get('dynamic_token'), 'preserved'); assert.equal(query.get('future_constant'), 'kept'); assert.equal(query.get('seller_id'), SELLER); assert.equal(query.get('oec_seller_id'), SELLER); }
  const products = readFirstWorksheet(fs.readFileSync(result.artifacts[0].output_file)), skus = readFirstWorksheet(fs.readFileSync(result.artifacts[1].output_file));
  assert.match(products.rows[1][3], /product_future/u); assert.match(skus.rows[1][4], /sku_future/u);
  assert.equal(products.rows[1][4], 'PHP'); assert.equal(skus.rows[1][5], 'PHP');
});

test('commercial status trusts four zero tabs and rejects pagination, identity, and URL drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-commercial-gates-')), spec = loadReportMd().specs.shop_product_commercial_status_snapshot, provider = spec.providers.cross_border, contract = provider.api_contract;
  async function execute(name, mutate, options = {}) {
    const seed = new URL(`${provider.response_origin}${contract.endpoint_path}`); seed.searchParams.set('seller_id', SELLER); seed.searchParams.set('oec_seller_id', SELLER);
    let connected = true;
    const page = { url:() => 'https://seller.tiktokshopglobalselling.com/homepage', waitForResponse:async (predicate) => { const item={url:()=>seed.href}; if(!predicate(item)) throw new Error('timeout'); return item; }, goto:async()=>{}, evaluate:async(_fn,{requestUrl:url})=>{
      const u=new URL(url), pageNumber=Number(u.searchParams.get('page_number')), tab=u.searchParams.get('tab_id');
      let body={code:0,data:{total_product_count:0,page_number:pageNumber,page_size:50}}; let finalUrl=url;
      ({body,finalUrl,connected}=mutate?.({body,finalUrl,pageNumber,tab,connected})||{body,finalUrl,connected});
      if(options.throwTransport) throw new Error('transport'); return {final_url:finalUrl,http_status:200,body};
    }};
    const context={pages:()=>[page]},browser={isConnected:()=>connected,contexts:()=>[context]};
    return commercial.run(input(spec,path.join(root,name)),{browser,browserContext:context,skillRoot:path.resolve(__dirname,'..')});
  }
  const zero=await execute('zero'); assert.equal(zero.status,'no_data'); assert.deepEqual(zero.artifacts.map((item)=>[item.logical_table,item.row_count]),[['products',0],['skus',0]]);
  const badSku=({body,...rest})=>({body:{code:0,data:{total_product_count:1,page_number:1,page_size:50,products:[{product_id:'1',total_sku_count:2,skus:[{id:'2'}]}]}},...rest});
  await assert.rejects(()=>execute('sku-count',badSku),{code:'shop_product_commercial_identity_incomplete'});
  await assert.rejects(()=>execute('page-drift',({body,...rest})=>({body:{...body,data:{...body.data,page_number:2}},...rest})),{code:'shop_product_commercial_shape_mismatch'});
  await assert.rejects(()=>execute('total-drift',({body,pageNumber,tab,...rest})=>({body:tab==='1'?{code:0,data:{total_product_count:pageNumber===1?2:3,page_number:pageNumber,page_size:50,products:[{product_id:String(pageNumber),total_sku_count:0,skus:[]}]}}:body,pageNumber,tab,...rest})),{code:'shop_product_commercial_pagination_incomplete'});
  for(const origin of ['https://evil.example','https://seller-ph.tiktok.com']) await assert.rejects(()=>execute(new URL(origin).hostname,({finalUrl,...rest})=>({finalUrl:`${origin}${new URL(finalUrl).pathname}${new URL(finalUrl).search}`,...rest})),{code:'seller_origin_mismatch'});
  await assert.rejects(()=>execute('seller-drift',({finalUrl,...rest})=>{const u=new URL(finalUrl);u.searchParams.set('seller_id','9');return{finalUrl:u.href,...rest};}),{code:'provider_binding_invalid'});
  await assert.rejects(()=>execute('disconnect',({body,finalUrl})=>({body,finalUrl,connected:false})),{code:'browser_disconnected'});
  await assert.rejects(()=>execute('transport-diagnostic',null,{throwTransport:true}),(error)=>{
    assert.equal(error.code,'shop_product_commercial_transport_error');assert.equal(error.diagnostics.tab_id,1);assert.equal(error.diagnostics.page_number,1);
    assert.equal(error.diagnostics.origin,provider.response_origin);assert.equal(error.diagnostics.path,contract.endpoint_path);assert.equal(error.diagnostics.error_category,'renderer_evaluate_failure');return true;
  });
});

test('commercial status spec rejects missing consumed fields while allowing unrelated metadata', () => {
  const spec=structuredClone(loadReportMd().specs.shop_product_commercial_status_snapshot),provider=spec.providers.cross_border;
  spec.metadata={future:true};provider.metadata={future:true};provider.api_contract.metadata={future:true};commercial.validateSpec(spec,provider,{skillRoot:path.resolve(__dirname,'..')});
  for(const field of ['entry_path','endpoint_path','response_page_path','response_page_size_path','max_pages']){const invalid=structuredClone(spec);delete invalid.providers.cross_border.api_contract[field];assert.throws(()=>commercial.validateSpec(invalid,invalid.providers.cross_border,{skillRoot:path.resolve(__dirname,'..')}),{code:'shop_product_commercial_spec_invalid'});}
  const nested=structuredClone(spec);nested.providers.cross_border.api_contract.sku_list_path=['inventory','skus'];assert.throws(()=>commercial.validateSpec(nested,nested.providers.cross_border,{skillRoot:path.resolve(__dirname,'..')}),{code:'shop_product_commercial_spec_invalid'});
  const currency=structuredClone(spec);currency.generated_currency.currency_code='USD';assert.throws(()=>commercial.validateSpec(currency,currency.providers.cross_border,{skillRoot:path.resolve(__dirname,'..')}),{code:'shop_product_commercial_spec_invalid'});
});
