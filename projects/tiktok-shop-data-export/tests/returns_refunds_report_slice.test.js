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
const { exportReturnsRefundsSnapshot } = require('../scripts/routes/cross_border/returns_refunds_snapshot');

const SELLER_ID = '7494671404273272171';
const SELLER_URL = 'https://seller.tiktokshopglobalselling.com/order/return';
const EMPTY_STATE = '退货退款管理 暂无工单 24 小时内回复 0 自动批准（过去 7 天） 0 可申诉 0 等待回复的争议 0 等待商家处理 0 等待 TikTok Shop/客户处理 0';

function realSpec() { const spec = loadReportMd().specs.returns_refunds_snapshot; return { ...spec, api_contract: spec.providers.cross_border.api_contract }; }
function card(id, amount = '₱10') { return { biz_data: { main_order_id: `order-${id}`, reverse_main_order_id: id, return_price: amount }, card: {} }; }
function listResponse(total, cards, sellerId = SELLER_ID, code = 0, spec = realSpec()) {
  return { url: () => `https://api16-normal-sg.tiktokshopglobalselling.com${spec.api_contract.endpoint_path}?oec_seller_id=${sellerId}`, request: () => ({ method: () => 'POST' }), json: async () => ({ code, data: { total_count: total, cards } }) };
}
function listResponseWithoutCards(total, sellerId = SELLER_ID, spec = realSpec()) {
  return { url: () => `https://api16-normal-sg.tiktokshopglobalselling.com${spec.api_contract.endpoint_path}?oec_seller_id=${sellerId}`, request: () => ({ method: () => 'POST' }), json: async () => ({ code: 0, data: { total_count: total } }) };
}
function mockBrowser(options = {}) {
  const handlers = new Set(); const pending = [...(options.laterResponses || [])]; let closed = false; let gotoCount = 0; const gotos = []; const selectors = [];
  const control = { waitFor: async () => { if (options.missingControl) throw new Error('missing'); }, click: async () => {} };
  const page = {
    url: () => options.currentUrl || 'https://seller.tiktokshopglobalselling.com/homepage',
    on: (event, handler) => { if (event === 'response') handlers.add(handler); },
    off: (event, handler) => { if (event === 'response') handlers.delete(handler); },
    evaluate: async () => options.bodyText || '',
    waitForTimeout: async () => {},
    goto: async (url) => { gotoCount += 1; gotos.push(url); for (const response of options.initialResponses || []) for (const handler of handlers) handler(response); },
    locator: (selector) => { selectors.push(selector); return { first: () => control }; },
    waitForResponse: async (predicate) => { const response = pending.shift(); assert.equal(Boolean(response && predicate(response)), true); return response; },
  };
  const browserContext = { pages: () => [page] };
  return { browser: { isConnected: () => true, contexts: () => [browserContext], close: async () => { closed = true; } }, browserContext, closed: () => closed, gotoCount: () => gotoCount, gotos, selectors };
}
async function runReturns(root, options = {}) {
  const mock = mockBrowser(options);
  const spec = options.spec || structuredClone(realSpec());
  Object.assign(spec.api_contract, { current_page_timeout_ms: 1, list_timeout_ms: 1, poll_interval_ms: 1, page_control_timeout_ms: 1, page_response_timeout_ms: 1 });
  spec.providers.cross_border.api_contract = spec.api_contract;
  const result = await exportReturnsRefundsSnapshot({
    a: { shop_alias: '店铺', cdp_url: 'http://127.0.0.1:9222' },
    b: { seller_page_url: SELLER_URL },
    shop: { seller_id: SELLER_ID },
    reportSpec: spec,
    providerSpec: spec.providers.cross_border,
    outputDir: path.join(root, 'runner'),
  }, {
    browser: mock.browser,
    browserContext: mock.browserContext,
    clock: () => new Date('2026-07-28T00:00:00.000Z'),
    currentPageWaitMs: 1,
    listWaitMs: 1,
    pageControlWaitMs: 1,
    pageWaitMs: 1,
    pollMs: 0,
  });
  assert.equal(mock.closed(), false);
  return { result, mock };
}

test('real returns router and report spec expose only direct and dedicated aliases', () => {
  const loaded = loadReportMd(); const spec = loaded.specs.returns_refunds_snapshot;
  assert.equal(spec.headers.length, 16); assert.deepEqual(spec.required_key_columns, ['售后单号']);
  assert.equal(spec.providers.cross_border.api_contract.zero_records_policy, 'missing_or_empty');
  assert.deepEqual(resolveReportIds('退货退款诊断快照', loaded), ['returns_refunds_snapshot']);
  assert.deepEqual(resolveReportIds('category:after_sales_diagnostics', loaded), ['returns_refunds_snapshot']);
  assert.deepEqual(resolveReportIds('退货退款专用', loaded), ['returns_refunds_snapshot']);
  assert.throws(() => resolveReportIds('all', loaded), { code: 'report_alias_unknown' });
  assert.throws(() => resolveReportIds('default', loaded), { code: 'report_alias_unknown' });
});

test('returns runner collects multiple pages with MD headers and publishes current snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-slice-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result, mock } = await runReturns(root, { currentUrl: SELLER_URL, initialResponses: [listResponse('3', [card('reverse-1'), card('reverse-2')])], laterResponses: [listResponse('3', [card('reverse-3')])] });
  const spec = realSpec(); assert.equal(mock.gotoCount(), 1); assert.equal(result.status, 'success'); assert.equal(result.row_count, 3); assert.deepEqual(result.currency_evidence, { currency_code: 'PHP', currency_symbol: '₱', currency_source: 'official_amount_symbol', amount_scope: 'all_monetary_fields' });
  const runnerSheet = readFirstWorksheet(fs.readFileSync(result.output_file)); assert.deepEqual(runnerSheet.headers, spec.headers); assert.equal(runnerSheet.rows.length, 4);
  assert.equal(runnerSheet.rows[1][spec.headers.indexOf('币种')], 'PHP');
  const shopRoot = path.join(root, 'shop'); const published = publishGeneratedXlsx({ spec, sourceFile: result.output_file, shopRoot, variables: { time_file: '当前快照.xlsx' }, taskId: 'returns-data' });
  const expected = path.join(shopRoot, '店铺数据', '退货退款快照', '当前快照.xlsx');
  assert.equal(published.status, 'success'); assert.equal(published.output_file, expected); assert.equal(published.data_row_count, 3); assert.equal(published.sha256, crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex'));
});

test('official UI empty state creates a header-only trusted-zero workbook without navigation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-ui-zero-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result, mock } = await runReturns(root, { currentUrl: SELLER_URL, bodyText: EMPTY_STATE });
  assert.equal(mock.gotoCount(), 0); assert.equal(result.status, 'no_data'); assert.equal(result.no_data_evidence, 'official_empty_state'); assert.equal(result.row_count, 0);
  assert.deepEqual(readFirstWorksheet(fs.readFileSync(result.output_file)).rows, [realSpec().headers]);
});

test('UI empty state waits for an already-triggered delayed successful API response', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-ui-race-success-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delayed = listResponse(1, [card('reverse-delayed')]); const json = delayed.json; delayed.json = async () => { await new Promise((resolve) => setImmediate(resolve)); return json(); };
  const { result } = await runReturns(root, { bodyText: EMPTY_STATE, initialResponses: [delayed] });
  assert.equal(result.status, 'success'); assert.equal(result.row_count, 1); assert.equal(result.no_data_evidence, undefined);
});

test('UI empty state cannot hide an already-triggered delayed malformed successful API response', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-ui-race-invalid-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delayed = listResponse('bad', null); const json = delayed.json; delayed.json = async () => { await new Promise((resolve) => setImmediate(resolve)); return json(); };
  await assert.rejects(runReturns(root, { bodyText: EMPTY_STATE, initialResponses: [delayed] }), { code: 'returns_refunds_page_invalid' });
});

test('official API zero atomically replaces an old nonempty formal workbook', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-api-zero-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const spec = realSpec();
  const { result } = await runReturns(root, { initialResponses: [listResponse(0, [])] });
  assert.equal(result.status, 'no_data'); assert.equal(result.no_data_evidence, 'official_total_count_zero');
  const shopRoot = path.join(root, 'shop'); const expected = path.join(shopRoot, '店铺数据', '退货退款快照', '当前快照.xlsx'); fs.mkdirSync(path.dirname(expected), { recursive: true });
  const oldRow = Array(spec.headers.length).fill('旧值'); writeWorkbook(expected, [spec.headers, oldRow]); const oldHash = crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex');
  const published = publishGeneratedXlsx({ spec, sourceFile: result.output_file, shopRoot, variables: { time_file: '当前快照.xlsx' }, taskId: 'returns-zero', trustedZero: true });
  assert.equal(published.status, 'no_data'); assert.equal(published.data_row_count, 0); assert.notEqual(published.sha256, oldHash); assert.deepEqual(readFirstWorksheet(fs.readFileSync(expected)).rows, [spec.headers]);
});

test('official API zero accepts an omitted cards field used by cross-border shops', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-api-zero-missing-cards-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result } = await runReturns(root, { initialResponses: [listResponseWithoutCards(0)] });
  assert.equal(result.status, 'no_data'); assert.equal(result.no_data_evidence, 'official_total_count_zero'); assert.equal(result.row_count, 0);
  assert.deepEqual(readFirstWorksheet(fs.readFileSync(result.output_file)).rows, [realSpec().headers]);
});

test('returns runner rejects malformed successful responses identity drift and pagination contradictions', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-invalid-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const malformed = listResponse('bad', null); const valid = listResponse(1, [card('reverse-1')]);
  await assert.rejects(runReturns(root, { initialResponses: [malformed, valid] }), { code: 'returns_refunds_page_invalid' });
  await assert.rejects(runReturns(root, { initialResponses: [listResponseWithoutCards(1)] }), { code: 'returns_refunds_page_invalid' });
  await assert.rejects(runReturns(root, { initialResponses: [listResponse(1, [card('reverse-1')], '999')] }), { code: 'returns_refunds_identity_mismatch' });
  await assert.rejects(runReturns(root, { initialResponses: [listResponse(3, [card('reverse-1'), card('reverse-2')])], laterResponses: [listResponse(4, [card('reverse-3')])] }), { code: 'returns_refunds_total_drift' });
  await assert.rejects(runReturns(root, { initialResponses: [listResponse(2, [card('reverse-1')])], laterResponses: [listResponse(2, [card('reverse-1')])] }), { code: 'returns_refunds_collection_incomplete' });
  await assert.rejects(runReturns(root, { initialResponses: [listResponse(1, [card('')])] }), { code: 'returns_refunds_collection_incomplete' });
  await assert.rejects(runReturns(root, { initialResponses: [listResponse(2, [card('reverse-1')])], missingControl: true }), { code: 'returns_refunds_page_control_missing' });
});

test('returns runner retains PHP currency evidence and rejects unknown or absent evidence', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-currency-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(runReturns(root, { initialResponses: [listResponse(1, [card('reverse-1', '$10')])] }), { code: 'returns_refunds_currency_unknown' });
  await assert.rejects(runReturns(root, { initialResponses: [listResponse(1, [card('reverse-1', '')])] }), { code: 'returns_refunds_currency_unknown' });
});

test('returns spec and identity fail before browser access', async () => {
  await assert.rejects(exportReturnsRefundsSnapshot({}, {}), { code: 'returns_refunds_report_spec_invalid' });
  await assert.rejects(exportReturnsRefundsSnapshot({ reportSpec: realSpec(), shop: { seller_id: 'invalid' } }, {}), { code: 'returns_refunds_identity_unavailable' });
});

test('returns entry endpoint page locator and query are driven by MD rules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'returns-sentinel-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = structuredClone(realSpec()); Object.assign(spec.api_contract, { entry_path: '/sentinel-return', endpoint_path: '/sentinel-return-list', page_control_template: '[data-sentinel-page="{{page_number}}"]' }); spec.api_contract.entry_query = { tab: 'sentinel-tab' }; spec.providers.cross_border.api_contract = spec.api_contract;
  const first = listResponse(2, [card('reverse-1')], SELLER_ID, 0, spec); const second = listResponse(2, [card('reverse-2')], SELLER_ID, 0, spec);
  const { result, mock } = await runReturns(root, { spec, initialResponses: [first], laterResponses: [second] });
  assert.equal(result.row_count, 2); const entered = new URL(mock.gotos[0]); assert.equal(entered.pathname, '/sentinel-return'); assert.equal(entered.searchParams.get('tab'), 'sentinel-tab'); assert.deepEqual(mock.selectors, ['[data-sentinel-page="2"]']);
});
