'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadReportMd } = require('../scripts/load-report-md');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');
const { writeWorkbook } = require('../scripts/common/xlsx_writer');

const ROOT = path.resolve(__dirname, '..');
const IDS = ['gmvmax_campaign_product_performance'];
const SELLER = '88001'; const ADVERTISER = '22001'; const BC = '33001';

function temporary(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gmvmax-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function loaded(id) { return loadReportMd().specs[id]; }
function moduleFor(id) { return require(path.join(ROOT, loaded(id).providers.cross_border.runner)); }
function put(target, parts, value) {
  let current = target;
  for (const part of parts.slice(0, -1)) { current[part] ??= {}; current = current[part]; }
  current[parts.at(-1)] = value;
}
function response(url, body, headers = { 'content-type': 'application/json' }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return { url: () => url, status: () => 200, headers: () => headers, body: async () => bytes };
}
function pageBody(rules, rows, page, pageCount, total) {
  const body = { code: 0, seller_id: SELLER, advertiser_id: ADVERTISER };
  put(body, rules.response_paths.table, rows);
  put(body, rules.response_paths.pagination, {
    [rules.response_paths.page]: page,
    [rules.response_paths.page_count]: pageCount,
    [rules.response_paths.total]: total,
  });
  return body;
}
function inputFor(spec, outputDir, overrides = {}) {
  return {
    a: {}, b: { seller_page_url: 'https://seller.tiktokshopglobalselling.com/home' },
    shop: { seller_id: SELLER, provider_id: 'cross_border' }, reportSpec: spec,
    providerSpec: spec.providers.cross_border, outputDir, startDate: '2026-08-20', endDate: '2026-08-20',
    advertiserId: ADVERTISER, advertiserName: 'Advertiser', businessCenterId: BC,
    campaignRef: null, productRef: null, ...overrides,
  };
}
function workbook(root, name, rows = [['future header'], ['business row']]) {
  const target = path.join(root, name); writeWorkbook(target, rows); return fs.readFileSync(target);
}

test('both reports expose independent provider runners with extensible MD rules', () => {
  for (const id of IDS) {
    const spec = structuredClone(loaded(id)); const provider = spec.providers.cross_border;
    assert.equal(spec.enabled, true); assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']);
    assert.equal(provider.response_origin, 'https://seller.tiktokshopglobalselling.com');
    provider.future_metadata = { ignored: true }; provider.official_validation.future_metadata = true;
    provider.official_validation.response_paths.future_metadata = ['ignored'];
    spec.providers.local = { future_metadata: { ignored: true } };
    assert.equal(moduleFor(id).validateSpec(spec, provider, { skillRoot: ROOT }), spec);
    const missing = structuredClone(spec); delete missing.providers.cross_border.official_validation.task_query_endpoint;
    assert.throws(() => moduleFor(id).validateSpec(missing, missing.providers.cross_border, { skillRoot: ROOT }));
  }
});

test('product report fully pages campaign/product discovery and binds one task to unchanged official bytes', async (t) => {
  const root = temporary(t, 'product'); const spec = loaded('gmvmax_campaign_product_performance');
  const rules = spec.providers.cross_border.official_validation; const calls = []; let downloads = 0;
  const bytes = workbook(root, 'arbitrary.xlsx'); const taskId = '9001';
  const page = { url: () => 'https://seller.tiktokshopglobalselling.com/home', request: { fetch: async (url, options) => {
    const target = new URL(url); const body = options.data; calls.push({ path: target.pathname, query: target.searchParams, body });
    assert.equal(target.origin, spec.providers.cross_border.response_origin);
    assert.equal(target.searchParams.get(rules.query_parameters.seller_id), SELLER);
    assert.equal(target.searchParams.get(rules.query_parameters.advertiser_id), ADVERTISER);
    if (target.pathname === rules.campaign_endpoint) {
      const item = body.page === 1 ? { campaign_id: '101', campaign_name: 'Campaign A' } : { campaign_id: '102', campaign_name: 'Campaign B' };
      return response(url, pageBody(rules, [item], body.page, 2, 2));
    }
    if (target.pathname === rules.product_endpoint && body.action !== rules.create_request.action) {
      const item = body.page === 1 ? { product_id: '501' } : { product_id: '502' };
      return response(url, pageBody(rules, [item], body.page, 2, 2));
    }
    if (target.pathname === rules.product_endpoint) return response(url, { code: 0, extra: { task_id: taskId } });
    if (target.pathname === rules.task_query_endpoint) return response(url, { code: 0, download_id: taskId, task_status: 'SUCCESS', url: 'https://download.example/product.xlsx' });
    throw new Error(`unexpected ${target.pathname}`);
  } } };
  const browserContext = { pages: () => [page], request: { get: async (url) => {
    downloads += 1; return response(url, bytes, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  } } };
  const browser = { isConnected: () => true, contexts: () => [browserContext] };
  const outputDir = path.join(root, 'stage'); fs.mkdirSync(outputDir);
  const result = await moduleFor(spec.report_id).run(inputFor(spec, outputDir, { campaignRef: '101' }), { browser, browserContext, delay: async () => {}, skillRoot: ROOT });
  assert.equal(result.status, 'success'); assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].official_total_count, 2); assert.equal(result.artifacts[0].data_row_count, 1);
  assert.deepEqual(fs.readFileSync(result.artifacts[0].output_file), bytes); assert.equal(downloads, 1);
  assert.equal(calls.filter((call) => call.path === rules.campaign_endpoint).length, 2);
  assert.equal(calls.filter((call) => call.path === rules.product_endpoint && call.body.action === undefined).length, 2);
  const creates = calls.filter((call) => call.path === rules.product_endpoint && call.body.action === rules.create_request.action);
  assert.equal(creates.length, 1); assert.equal(creates[0].body.campaign_id, '101'); assert.equal(creates[0].body.page_size, -1);
  assert.equal(calls.filter((call) => call.path === rules.task_query_endpoint).length, 1);
});

test('product report trusts only product total zero and rejects a header-only official workbook', async (t) => {
  async function execute(name, total, officialRows) {
    const root = temporary(t, name); const spec = loaded('gmvmax_campaign_product_performance');
    const rules = spec.providers.cross_border.official_validation; let creates = 0; let downloads = 0;
    const bytes = workbook(root, 'download.xlsx', officialRows); const page = { url: () => 'https://seller.tiktokshopglobalselling.com/home', request: { fetch: async (url, options) => {
      const target = new URL(url); const body = options.data;
      if (target.pathname === rules.campaign_endpoint) return response(url, pageBody(rules, [{ campaign_id: '101', campaign_name: 'Campaign' }], 1, 1, 1));
      if (target.pathname === rules.product_endpoint && body.action === undefined) return response(url, pageBody(rules, total ? [{ product_id: '501' }] : [], 1, total ? 1 : 0, total));
      if (target.pathname === rules.product_endpoint) { creates += 1; return response(url, { code: 0, extra: { task_id: '9001' } }); }
      return response(url, { code: 0, download_id: '9001', task_status: 'SUCCESS', url: 'https://download.example/file.xlsx' });
    } } };
    const browserContext = { pages: () => [page], request: { get: async (url) => { downloads += 1; return response(url, bytes, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); } } };
    const browser = { isConnected: () => true, contexts: () => [browserContext] }; const outputDir = path.join(root, 'stage'); fs.mkdirSync(outputDir);
    return { result: await moduleFor(spec.report_id).run(inputFor(spec, outputDir), { browser, browserContext, skillRoot: ROOT }), outputDir, creates, downloads };
  }
  const zero = await execute('zero', 0, [['unused']]); assert.equal(zero.result.status, 'no_data');
  assert.equal(zero.creates, 0); assert.equal(zero.downloads, 0);
  assert.deepEqual(readFirstWorksheet(fs.readFileSync(zero.result.artifacts[0].output_file)).rows, [loaded('gmvmax_campaign_product_performance').headers]);
  const empty = await execute('empty', 1, [['arbitrary header']]); assert.equal(empty.result.status, 'failed');
  assert.equal(empty.result.artifacts[0].reason_code, 'official_data_row_count_mismatch'); assert.deepEqual(fs.readdirSync(empty.outputDir), []);
});
