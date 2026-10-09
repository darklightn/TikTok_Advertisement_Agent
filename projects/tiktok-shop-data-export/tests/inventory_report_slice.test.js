'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');
const { publishGeneratedXlsx } = require('../scripts/common/output-publish');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');
const { writeWorkbook } = require('../scripts/common/xlsx_writer');
const inventoryCommon = require('../scripts/routes/common/inventory_snapshot');
const { run: runCrossInventory, validateSpec: validateCrossSpec } = require('../scripts/routes/cross_border/inventory_snapshot');
const { run: runLocalInventory, validateSpec: validateLocalSpec } = require('../scripts/routes/local/inventory_snapshot');

const SELLER_ID = '7494671404273272171';
const SELLER_URL = 'https://seller-ph.tiktok.com/product/stock';

function realSpec() {
  return loadReportMd().specs.inventory_snapshot;
}

function sku(skuId, productId) {
  return {
    product_id: productId,
    sku_id: skuId,
    product_title: `商品-${productId}`,
    seller_sku: `SELLER-${skuId}`,
    properties: [{ name: '颜色', value_name: '蓝色' }],
    status: 1,
    warehouse_total_quantity: 9,
    open_quantity: 7,
    withholding_quantity: 2,
    sku_sales: 3,
    sku_forecast_sales: 4,
    sku_replenishment_quantity: 0,
    sku_stock_days_left: '20',
    warehouse_stock_list: [{ warehouse_name: '仓库A' }],
  };
}

function stockResponse(sellerId, total, skus, spec = realSpec(), providerId = 'local', origin = spec.providers[providerId].response_origin) {
  return {
    url: () => `${origin}${spec.providers[providerId].endpoint_path}?oec_seller_id=${sellerId}`,
    json: async () => ({ code: 0, total_sku_count: total, skus }),
  };
}

function mockBrowser(firstResponse, laterResponses = [], pageUrl = SELLER_URL) {
  const initialResponses = Array.isArray(firstResponse) ? firstResponse : [firstResponse];
  const handlers = new Set();
  const pending = [...laterResponses];
  const observedPaths = []; const observedSelectors = []; const observedResponseMatches = [];
  let closed = false;
  const next = { count: async () => 1, getAttribute: async () => '', click: async () => {} };
  const page = {
    url: () => pageUrl,
    on: (event, handler) => { if (event === 'response') handlers.add(handler); },
    off: (event, handler) => { if (event === 'response') handlers.delete(handler); },
    goto: async (url) => {
      observedPaths.push(new URL(url).pathname);
      await Promise.all(initialResponses.flatMap((response) => [...handlers].map((handler) => handler(response))));
    },
    locator: (selector) => { observedSelectors.push(selector); return next; },
    waitForResponse: async (predicate) => {
      const response = pending.shift();
      const accepted = Boolean(response && predicate(response)); observedResponseMatches.push(accepted);
      if (!accepted) throw Object.assign(new Error('response_predicate_rejected'), { code: 'response_predicate_rejected' });
      return response;
    },
  };
  const browserContext = { pages: () => [page] };
  return {
    browser: { isConnected: () => true, contexts: () => [browserContext], close: async () => { closed = true; } },
    browserContext,
    closed: () => closed,
    observedPaths, observedSelectors, observedResponseMatches,
  };
}

async function runInventory(root, firstResponse, laterResponses = [], options = {}) {
  const providerId = options.providerId || 'local'; const spec = options.spec || realSpec();
  const runner = providerId === 'cross_border' ? runCrossInventory : runLocalInventory;
  const frozenUrl = options.frozenUrl || SELLER_URL;
  const mock = mockBrowser(firstResponse, laterResponses, options.currentPageUrl || frozenUrl);
  const result = await runner({
    a: { shop_alias: '店铺', cdp_url: 'http://127.0.0.1:9222' },
    b: { seller_page_url: frozenUrl },
    shop: { seller_id: SELLER_ID },
    reportSpec: spec, providerSpec: spec.providers[providerId],
    outputDir: path.join(root, 'runner'),
  }, {
    browser: mock.browser,
    browserContext: mock.browserContext,
    clock: () => new Date('2026-07-28T00:00:00.000Z'),
    waitForCapture: async (_page, ready) => { assert.equal(ready(), true); },
  });
  assert.equal(mock.closed(), false);
  assert.deepEqual(mock.observedPaths, [spec.providers[providerId].entry_path]);
  return result;
}

test('real inventory router and report spec expose only direct and dedicated aliases', () => {
  const loaded = loadReportMd();
  const spec = loaded.specs.inventory_snapshot;
  assert.equal(spec.headers.length, 16);
  assert.deepEqual(spec.required_key_columns, ['商品ID', 'SKU ID']);
  assert.equal(spec.runner, undefined);
  assert.equal(spec.api_contract, undefined);
  assert.equal(spec.providers.cross_border.runner, 'scripts/routes/cross_border/inventory_snapshot.js');
  assert.equal(spec.providers.local.runner, 'scripts/routes/local/inventory_snapshot.js');
  assert.equal(spec.providers.cross_border.response_origin, 'https://api16-normal-sg.tiktokshopglobalselling.com');
  assert.equal(spec.providers.local.response_origin, 'https://seller-ph.tiktok.com');
  assert.deepEqual(resolveReportIds('库存快照', loaded), ['inventory_snapshot']);
  assert.deepEqual(resolveReportIds('category:inventory_availability', loaded), ['inventory_snapshot']);
  assert.deepEqual(resolveReportIds('库存专用', loaded), ['inventory_snapshot']);
  assert.throws(() => resolveReportIds('all', loaded), { code: 'report_alias_unknown' });
});

test('real inventory runner paginates into MD headers and publishes current snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-slice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = realSpec();
  const result = await runInventory(root,
    stockResponse(SELLER_ID, 3, [sku('sku-1', 'product-1'), sku('sku-2', 'product-2')]),
    [stockResponse(SELLER_ID, 3, [sku('sku-3', 'product-3')])]);
  assert.equal(result.status, 'success');
  assert.equal(result.row_count, 3);
  const runnerSheet = readFirstWorksheet(fs.readFileSync(result.output_file));
  assert.deepEqual(runnerSheet.headers, spec.headers);
  assert.equal(runnerSheet.headers.length, 16);
  assert.equal(runnerSheet.rows.length, 4);
  const shopRoot = path.join(root, 'shop');
  const published = publishGeneratedXlsx({ spec, sourceFile: result.output_file, shopRoot, variables: { time_file: '当前快照.xlsx' }, taskId: 'inventory-data' });
  const expected = path.join(shopRoot, '店铺数据', '库存快照', '当前快照.xlsx');
  assert.equal(published.status, 'success');
  assert.equal(published.output_file, expected);
  assert.equal(published.data_row_count, 3);
  assert.equal(published.sha256, crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex'));
});

test('trusted official zero publishes a header-only workbook over the old formal file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-zero-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = realSpec();
  const result = await runInventory(root, stockResponse(SELLER_ID, 0, []));
  assert.equal(result.status, 'no_data');
  assert.equal(result.row_count, 0);
  const shopRoot = path.join(root, 'shop');
  const expected = path.join(shopRoot, '店铺数据', '库存快照', '当前快照.xlsx');
  fs.mkdirSync(path.dirname(expected), { recursive: true });
  const oldRow = Array(spec.headers.length).fill('旧值');
  writeWorkbook(expected, [spec.headers, oldRow]);
  const oldHash = crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex');
  const published = publishGeneratedXlsx({ spec, sourceFile: result.output_file, shopRoot, variables: { time_file: '当前快照.xlsx' }, taskId: 'inventory-zero', trustedZero: true });
  assert.equal(published.status, 'no_data');
  assert.equal(published.output_file, expected);
  assert.equal(published.data_row_count, 0);
  assert.notEqual(published.sha256, oldHash);
  const sheet = readFirstWorksheet(fs.readFileSync(expected));
  assert.deepEqual(sheet.headers, spec.headers);
  assert.equal(sheet.rows.length, 1);
});

test('inventory runner fails closed on identity total and report-spec contradictions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(runLocalInventory({}, {}), { code: 'inventory_report_spec_invalid' });
  for (const [providerId, validate] of [['cross_border', validateCrossSpec], ['local', validateLocalSpec]]) {
    for (const responseOrigin of [undefined, 'http://seller-ph.tiktok.com', 'https://seller-ph.tiktok.com/', 'https://seller-ph.tiktok.com/path', 'https://seller-ph.tiktok.com?x=1', 'https://seller-ph.tiktok.com#x']) {
      const spec = structuredClone(realSpec()); spec.providers[providerId].response_origin = responseOrigin;
      assert.throws(() => validate(spec, spec.providers[providerId]), { code: 'inventory_report_spec_invalid' });
    }
  }
  await assert.rejects(runInventory(root, stockResponse('999', 0, [])), { code: 'inventory_shop_identity_mismatch' });
  await assert.rejects(runInventory(root,
    stockResponse(SELLER_ID, 3, [sku('sku-1', 'product-1'), sku('sku-2', 'product-2')]),
    [stockResponse(SELLER_ID, 4, [sku('sku-3', 'product-3')])]), { code: 'inventory_incomplete' });
  await assert.rejects(runInventory(root, stockResponse(SELLER_ID, 0, [sku('sku-1', 'product-1')])), { code: 'inventory_incomplete' });
  const malformed = stockResponse(SELLER_ID, 1, []);
  malformed.json = async () => ({ code: 0, total_sku_count: 1, skus: null });
  await assert.rejects(runInventory(root, [malformed, stockResponse(SELLER_ID, 1, [sku('sku-1', 'product-1')])]), { code: 'inventory_incomplete' });
  await assert.rejects(runInventory(root, stockResponse(SELLER_ID, 1, [sku('sku-1', '')])), { code: 'inventory_incomplete' });
});

test('each inventory provider runner consumes only its own MD execution rules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-sentinel-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const providerId of ['cross_border', 'local']) {
    const spec = structuredClone(realSpec());
    Object.assign(spec.providers[providerId], { entry_path: `/${providerId}-sentinel-stock`, response_origin: `https://${providerId.replace('_', '-')}.sentinel.example`, endpoint_path: `/${providerId}-sentinel-api`, next_page_selector: `[data-provider="${providerId}"]`, navigation_timeout_ms: 4321, capture_timeout_ms: 5432, poll_interval_ms: 7 });
    const otherProvider = providerId === 'local' ? 'cross_border' : 'local';
    assert.equal(spec.providers[otherProvider].entry_path, '/product/stock');
    assert.equal(spec.providers[otherProvider].response_origin, realSpec().providers[otherProvider].response_origin);
    const response = stockResponse(SELLER_ID, 2, [sku(`${providerId}-1`, 'product-1')], spec, providerId);
    const later = stockResponse(SELLER_ID, 2, [sku(`${providerId}-2`, 'product-2')], spec, providerId);
    const mock = mockBrowser(response, [later]); let captureOptions;
    const runner = providerId === 'cross_border' ? runCrossInventory : runLocalInventory;
    const result = await runner({ a: { shop_alias: '店铺' }, b: { seller_page_url: SELLER_URL }, shop: { seller_id: SELLER_ID }, reportSpec: spec, providerSpec: spec.providers[providerId], outputDir: path.join(root, providerId) }, { browser: mock.browser, browserContext: mock.browserContext, waitForCapture: async (_page, ready, options) => { captureOptions = options; assert.equal(ready(), true); } });
    assert.equal(result.row_count, 2); assert.deepEqual(mock.observedPaths, [`/${providerId}-sentinel-stock`]); assert.deepEqual(mock.observedSelectors, [`[data-provider="${providerId}"]`]); assert.deepEqual(captureOptions, { timeoutMs: 5432, pollMs: 7 });
  }
});

test('each inventory runner reuses only a current page on the frozen Seller origin', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-page-origin-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frozenUrl = 'https://seller-ph.tiktok.com/home';
  for (const providerId of ['cross_border', 'local']) {
    const result = await runInventory(root, stockResponse(SELLER_ID, 0, [], realSpec(), providerId), [], {
      providerId, frozenUrl, currentPageUrl: 'https://seller-ph.tiktok.com/previous-report',
    });
    assert.equal(result.status, 'no_data');

    const spec = realSpec(); const runner = providerId === 'cross_border' ? runCrossInventory : runLocalInventory;
    const mock = mockBrowser(stockResponse(SELLER_ID, 0, [], spec, providerId), [], 'https://seller.tiktokshopglobalselling.com/previous-report');
    await assert.rejects(runner({
      a: { shop_alias: '店铺' }, b: { seller_page_url: frozenUrl }, shop: { seller_id: SELLER_ID },
      reportSpec: spec, providerSpec: spec.providers[providerId], outputDir: path.join(root, `${providerId}-other-origin`),
    }, { browser: mock.browser, browserContext: mock.browserContext }), { code: 'seller_page_missing' });
    assert.deepEqual(mock.observedPaths, []);
  }
});

test('each inventory runner rejects cross-origin initial and pagination API responses', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-response-origin-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const providerId of ['cross_border', 'local']) {
    const spec = realSpec(); const runner = providerId === 'cross_border' ? runCrossInventory : runLocalInventory;
    const input = (outputDir) => ({
      a: { shop_alias: '店铺' }, b: { seller_page_url: SELLER_URL }, shop: { seller_id: SELLER_ID },
      reportSpec: spec, providerSpec: spec.providers[providerId], outputDir,
    });
    const evilInitial = mockBrowser(stockResponse(SELLER_ID, 0, [], spec, providerId, 'https://evil.example'));
    const initialOutput = path.join(root, `${providerId}-initial`);
    await assert.rejects(runner(input(initialOutput), {
      browser: evilInitial.browser, browserContext: evilInitial.browserContext,
      waitForCapture: async (_page, ready) => { assert.equal(ready(), false); throw Object.assign(new Error('capture_timeout'), { code: 'capture_timeout' }); },
    }), { code: 'capture_timeout' });
    assert.equal(fs.existsSync(initialOutput), false);

    const first = stockResponse(SELLER_ID, 2, [sku(`${providerId}-1`, 'product-1')], spec, providerId);
    const evilPage = stockResponse(SELLER_ID, 2, [sku(`${providerId}-2`, 'product-2')], spec, providerId, 'https://evil.example');
    const pagination = mockBrowser(first, [evilPage]); const paginationOutput = path.join(root, `${providerId}-pagination`);
    await assert.rejects(runner(input(paginationOutput), {
      browser: pagination.browser, browserContext: pagination.browserContext,
      waitForCapture: async (_page, ready) => { assert.equal(ready(), true); },
    }), { code: 'response_predicate_rejected' });
    assert.deepEqual(pagination.observedResponseMatches, [false]);
    assert.equal(fs.existsSync(paginationOutput), false);
  }
});

test('inventory common module exposes no runner or browser pagination decisions', () => {
  assert.equal(inventoryCommon.run, undefined);
  assert.equal(inventoryCommon.exportInventorySnapshot, undefined);
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'routes', 'common', 'inventory_snapshot.js'), 'utf8');
  for (const marker of ['waitForCapture', '.goto(', '.locator(', 'waitForResponse', 'endpoint_path', 'next_page_selector']) {
    assert.equal(source.includes(marker), false);
  }
  for (const provider of ['cross_border', 'local']) {
    const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'routes', provider, 'inventory_snapshot.js'), 'utf8');
    assert.equal(runnerSource.includes('sellerOrigin'), false);
  }
});
