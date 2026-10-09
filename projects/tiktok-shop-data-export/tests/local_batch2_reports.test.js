'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { loadReportMd } = require('../scripts/load-report-md');
const commercial = require('../scripts/routes/local/shop_product_commercial_status_snapshot');
const orders = require('../scripts/routes/local/manage_orders_csv');
const crossOrders = require('../scripts/routes/cross_border/manage_orders_csv');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');

const ROOT = path.resolve(__dirname, '..');
const SELLER = '7496176775586483191';

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-batch2-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function commercialInput(spec, outputDir, sellerUrl = `${spec.providers.local.response_origin}/home`) { return { a: {}, b: { seller_page_url: sellerUrl }, shop: { seller_id: SELLER, provider_id: 'local' }, reportSpec: spec, providerSpec: spec.providers.local, outputDir }; }

function commercialHarness(spec, responseFactory) {
  const provider = spec.providers.local; const contract = provider.api_contract;
  const seed = new URL(`${provider.response_origin}${contract.endpoint_path}`);
  for (const name of contract.seller_query_names) seed.searchParams.set(name, SELLER);
  let gotoCount = 0; const requests = [];
  const page = {
    url: () => `${provider.response_origin}/home`,
    goto: async (url) => { gotoCount += 1; assert.equal(url, `${provider.response_origin}${contract.entry_path}`); },
    waitForResponse: async (predicate) => {
      const response = { url: () => seed.href, request: () => ({ method: () => contract.method }) };
      if (!predicate(response)) throw new Error('seed predicate mismatch');
      return response;
    },
    evaluate: async (_fn, { requestUrl, requestMethod }) => {
      requests.push(requestUrl); assert.equal(requestMethod, contract.method);
      const url = new URL(requestUrl); const tab = Number(url.searchParams.get(contract.query_fields.tab)); const pageNumber = Number(url.searchParams.get(contract.query_fields.page));
      return responseFactory({ url, tab, pageNumber, contract });
    },
  };
  const context = { pages: () => [page] }; const browser = { isConnected: () => true, contexts: () => [context] };
  return { browser, context, page, requests, getGotoCount: () => gotoCount };
}

test('local commercial runner paginates all four tabs and publishes product and SKU snapshots', async (t) => {
  const root = temporary(t); const spec = structuredClone(loadReportMd().specs.shop_product_commercial_status_snapshot); const provider = spec.providers.local;
  assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']); assert.equal(provider.api_contract.method, 'GET'); assert.equal(provider.api_contract.sku_number, 100);
  spec.providers.local.api_contract.page_size = 1;
  const live = commercialHarness(spec, ({ url, tab, pageNumber, contract }) => {
    const rows = tab === 1 && pageNumber <= 2 ? [{ product_id: String(100 + pageNumber), total_sku_count: 1, skus: [{ id: String(200 + pageNumber) }] }] : [];
    return { final_url: url.href, http_status: 200, body: { code: 0, data: { total_product_count: tab === 1 ? 2 : 0, page_number: pageNumber, page_size: contract.page_size, ...(rows.length ? { products: rows } : {}) } } };
  });
  const result = await commercial.run(commercialInput(spec, path.join(root, 'success')), { browser: live.browser, browserContext: live.context, skillRoot: ROOT });
  assert.equal(result.status, 'success'); assert.equal(result.provider_id, 'local'); assert.equal(live.getGotoCount(), 1); assert.equal(live.requests.length, 5);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.row_count), [2, 2]);
  for (const artifact of result.artifacts) {
    const sheet = readFirstWorksheet(fs.readFileSync(artifact.output_file));
    assert.equal(sheet.rows.length, 3); assert.equal(sheet.rows[1].at(-1), 'PHP');
  }
});

test('local commercial runner trusts four zero totals and fails closed on pagination, identity, and origin errors', async (t) => {
  const root = temporary(t); const spec = loadReportMd().specs.shop_product_commercial_status_snapshot; let run = 0;
  async function execute(factory, sellerUrl) {
    run += 1; const outputDir = path.join(root, `run-${run}`); const live = commercialHarness(spec, factory);
    return { promise: commercial.run(commercialInput(spec, outputDir, sellerUrl), { browser: live.browser, browserContext: live.context, skillRoot: ROOT }), outputDir, live };
  }
  const zero = await execute(({ url, pageNumber, contract }) => ({ final_url: url.href, http_status: 200, body: { code: 0, data: { total_product_count: 0, page_number: pageNumber, page_size: contract.page_size } } }));
  const zeroResult = await zero.promise; assert.equal(zeroResult.status, 'no_data'); assert.deepEqual(zeroResult.artifacts.map((artifact) => artifact.row_count), [0, 0]);
  const drift = await execute(({ url, pageNumber, contract }) => ({ final_url: url.href, http_status: 200, body: { code: 0, data: { total_product_count: 1, page_number: pageNumber + 1, page_size: contract.page_size, products: [] } } }));
  await assert.rejects(drift.promise, { code: 'shop_product_commercial_shape_mismatch' }); assert.equal(fs.existsSync(drift.outputDir), false);
  const badSku = await execute(({ url, pageNumber, contract }) => ({ final_url: url.href, http_status: 200, body: { code: 0, data: { total_product_count: 1, page_number: pageNumber, page_size: contract.page_size, products: [{ product_id: '101', total_sku_count: 2, skus: [{ id: '201' }] }] } } }));
  await assert.rejects(badSku.promise, { code: 'shop_product_commercial_identity_incomplete' }); assert.equal(fs.existsSync(badSku.outputDir), false);
  const wrongOrigin = await execute(() => { throw new Error('must not request'); }, 'https://seller.tiktokshopglobalselling.com/home');
  await assert.rejects(wrongOrigin.promise, { code: 'seller_origin_mismatch' }); assert.equal(wrongOrigin.live.getGotoCount(), 0); assert.equal(wrongOrigin.live.requests.length, 0); assert.equal(fs.existsSync(wrongOrigin.outputDir), false);
});

function orderResponse(origin, pathname, method, body, status = 200) {
  return { url: () => `${origin}${pathname}`, request: () => ({ method: () => method }), status: () => status, json: async () => body };
}

function orderExecution(t, options = {}) {
  const root = temporary(t); const spec = structuredClone(loadReportMd().specs.manage_orders_csv); const provider = spec.providers.local; const rules = provider.official_validation; const ui = rules.ui_contract;
  const outputDir = path.join(root, options.name || 'stage'); fs.mkdirSync(outputDir); const taskId = '8132319079312598788'; const recordName = 'official task row.csv';
  const bytes = options.bytes || Buffer.from('future headers\r\nrow one\r\nrow two\r\n'); let waits = 0; let clicks = 0; let downloads = 0;
  const downloadButton = { count: async () => 1, click: async () => { clicks += 1; } };
  const nameMatch = { count: async () => 1, first: () => ({ locator: () => ({ getByRole: () => downloadButton }) }) };
  const radios = { count: async () => ui.radio_count, nth: (index) => ({ isChecked: async () => ui.required_checked_indices.includes(index) }) };
  const dialog = { locator: () => radios, getByRole: () => ({ count: async () => 1, click: async () => {} }), getByText: (value) => { assert.equal(value, recordName); return nameMatch; } };
  const page = {
    url: () => `${provider.list_response_origin}/home`, locator: () => ({ count: async () => 1, nth: () => dialog }), goto: async () => {},
    waitForEvent: async () => { downloads += 1; if (options.downloadError) throw Object.assign(new Error('download'), { code: 'download_failed' }); return { createReadStream: async () => ({ async *[Symbol.asyncIterator]() { yield bytes; } }) }; },
    waitForResponse: async (predicate) => {
      waits += 1;
      if (waits === 1) { const response = orderResponse(provider.list_response_origin, `${rules.list_endpoint}?${ui.seller_query}=${SELLER}`, ui.list_method, { code: 0, data: { total_count: options.total ?? 1049 } }); assert.equal(await predicate(response), true); return response; }
      if (waits === 2) { await new Promise((resolve) => setImmediate(resolve)); const response = orderResponse(provider.task_response_origin, rules.create_endpoint, ui.create_method, { code: 0, data: { export_task_id: taskId } }); assert.equal(await predicate(response), true); return response; }
      await new Promise((resolve) => setImmediate(resolve)); const response = orderResponse(provider.task_response_origin, rules.record_endpoint, ui.record_method, { code: 0, data: { export_records: [{ export_task_id: taskId, file_key: 'key-1', file_name: encodeURIComponent(recordName) }] } }); assert.equal(await predicate(response), true); return response;
    },
  };
  const context = { pages: () => [page] }; const browser = { isConnected: () => true, contexts: () => [context] };
  const input = { a: {}, b: { seller_page_url: page.url() }, shop: { seller_id: SELLER, provider_id: 'local' }, reportSpec: spec, providerSpec: provider, outputDir, startDate: '2026-08-15', endDate: '2026-08-17' };
  return { promise: orders.run(input, { browser, browserContext: context, skillRoot: ROOT, currencyText: '₱' }), outputDir, getClicks: () => clicks, getDownloads: () => downloads };
}

test('local orders preserves official bytes and permits list total to differ from CSV logical row count', async (t) => {
  const orderSpec = loadReportMd().specs.manage_orders_csv; assert.equal(orderSpec.providers.local.official_validation.ui_contract.record_method, 'POST');
  assert.equal(orderSpec.providers.local.official_validation.task_timeout_ms, 240000);
  assert.equal(orderSpec.providers.cross_border.official_validation.task_timeout_ms, 120000);
  const execution = orderExecution(t, { total: 1049 }); const result = await execution.promise;
  assert.equal(result.status, 'success'); assert.equal(result.provider_id, 'local'); assert.equal(result.data_row_count, 2); assert.equal(execution.getClicks(), 1); assert.equal(execution.getDownloads(), 1);
  assert.deepEqual(fs.readFileSync(result.output_file), Buffer.from('future headers\r\nrow one\r\nrow two\r\n')); assert.equal(result.official_file_unchanged, true);
});

test('local orders accepts only trusted list zero and fails download or empty-data files before staging', async (t) => {
  const zero = orderExecution(t, { name: 'zero', total: 0 }); const zeroResult = await zero.promise;
  assert.equal(zeroResult.status, 'no_data'); assert.equal(zeroResult.row_count, 0); assert.equal(zeroResult.no_data_evidence, 'official_order_list_total_zero'); assert.equal(zero.getDownloads(), 0);
  const download = orderExecution(t, { name: 'download', downloadError: true }); await assert.rejects(download.promise, { code: 'download_failed' }); assert.deepEqual(fs.readdirSync(download.outputDir), []);
  const zeroBytes = orderExecution(t, { name: 'zero-bytes', bytes: Buffer.alloc(0) }); await assert.rejects(zeroBytes.promise, { code: 'official_file_empty' }); assert.deepEqual(fs.readdirSync(zeroBytes.outputDir), []);
  const empty = orderExecution(t, { name: 'empty', bytes: Buffer.from('future headers\r\n') }); await assert.rejects(empty.promise, { code: 'official_data_row_count_mismatch' }); assert.deepEqual(fs.readdirSync(empty.outputDir), []);
});

test('Batch 2 local providers are independent provider runners with MD-owned contracts', () => {
  const loaded = loadReportMd();
  for (const reportId of ['shop_product_commercial_status_snapshot', 'manage_orders_csv']) {
    const spec = loaded.specs[reportId]; assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']); assert.notEqual(spec.providers.cross_border.runner, spec.providers.local.runner);
    const localSource = fs.readFileSync(path.join(ROOT, spec.providers.local.runner), 'utf8'); const crossSource = fs.readFileSync(path.join(ROOT, spec.providers.cross_border.runner), 'utf8');
    assert.doesNotMatch(localSource, /routes[\\/]cross_border/u); assert.doesNotMatch(crossSource, /routes[\\/]local/u);
  }
  assert.deepEqual(Object.keys(loaded.specs.shop_product_growth_opportunity_snapshot.providers), ['cross_border', 'local']);
  assert.deepEqual(Object.keys(loaded.specs.affiliate_center_performance.providers), ['cross_border', 'local']);
});

test('both order provider validators accept future generated no-data headers', () => {
  const spec = structuredClone(loadReportMd().specs.manage_orders_csv);
  spec.headers.push('Future generated field');
  assert.doesNotThrow(() => crossOrders.validateSpec(spec, spec.providers.cross_border, { skillRoot: ROOT }));
  assert.doesNotThrow(() => orders.validateSpec(spec, spec.providers.local, { skillRoot: ROOT }));
});

test('both order providers wait for currency evidence on the bound report page', async () => {
  const contract = loadReportMd().specs.manage_orders_csv.currency_contract;
  for (const provider of [crossOrders, orders]) {
    let reads = 0;
    let delays = 0;
    const evidence = await provider.waitPageCurrency({}, contract, 1000, {
      readCurrencyText: async () => {
        reads += 1;
        return reads === 1 ? '' : 'Total ₱10.00';
      },
      delay: async () => {
        delays += 1;
      },
    });
    assert.equal(evidence.currency_code, 'PHP');
    assert.equal(evidence.currency_symbol, '₱');
    assert.equal(delays, 1);
  }
});
