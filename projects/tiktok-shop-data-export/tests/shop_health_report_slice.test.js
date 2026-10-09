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
const { exportShopHealthSnapshot } = require('../scripts/routes/local/shop_health_snapshot');

const SELLER_ID = '7494671404273272171';
const SELLER_URL = 'https://seller-ph.tiktok.com/health-center';

function realSpec() { const spec = loadReportMd().specs.shop_health_snapshot; return { ...spec, api_contract: spec.providers.local.api_contract }; }
function bodies() {
  return {
    score: { code: 0, data: { score: 200 } },
    overview: { code: 0, data: { violation_score: 0, start_time: 1783900800, end_time: 1784419200, unread_violation_number: 0 } },
    metrics: { code: 0, data: { metric_groups: [{ violation_type: '服务指标违规', metrics: [{ title: '12 小时响应率', unit: 101, value: 1, target_value: 0.85, operator: 3, start_time: 1782518400, end_time: 1785024000, violation_count: 0, tooltip: '官方口径' }] }] } },
  };
}
function response(key, body, sellerId = SELLER_ID, spec = realSpec()) {
  return { url: () => `https://seller-ph.tiktok.com${spec.api_contract.response_paths[key]}?oec_seller_id=${sellerId}`, request: () => ({ method: () => spec.api_contract.methods[key] }), json: async () => body };
}
function mockBrowser(responses) {
  const handlers = new Set(); const paths = []; let closed = false;
  const page = {
    url: () => SELLER_URL,
    on: (event, handler) => { if (event === 'response') handlers.add(handler); },
    off: (event, handler) => { if (event === 'response') handlers.delete(handler); },
    goto: async (url) => { paths.push(new URL(url).pathname); await Promise.all(responses.flatMap((item) => [...handlers].map((handler) => handler(item)))); },
  };
  const browserContext = { pages: () => [page] };
  return { browser: { isConnected: () => true, contexts: () => [browserContext], close: async () => { closed = true; } }, browserContext, closed: () => closed, paths };
}
async function runHealth(root, responses, options = {}) {
  const mock = mockBrowser(responses);
  const spec = realSpec();
  const result = await exportShopHealthSnapshot({
    a: { shop_alias: '店铺', cdp_url: 'http://127.0.0.1:9222' },
    b: { seller_page_url: SELLER_URL },
    shop: { seller_id: SELLER_ID },
    reportSpec: spec,
    providerSpec: spec.providers.local,
    outputDir: path.join(root, 'runner'),
  }, {
    browser: mock.browser,
    browserContext: mock.browserContext,
    clock: () => new Date('2026-07-28T00:00:00.000Z'),
    waitForCapture: async (_page, ready) => { if (options.requireReady !== false) assert.equal(ready(), true); },
  });
  assert.equal(mock.closed(), false);
  assert.deepEqual(mock.paths, ['/health-center']);
  return result;
}

test('real shop health router and report spec expose only direct and dedicated aliases', () => {
  const loaded = loadReportMd(); const spec = loaded.specs.shop_health_snapshot;
  assert.equal(spec.headers.length, 9);
  assert.deepEqual(spec.required_key_columns, ['类别', '指标']);
  assert.equal(spec.providers.local.api_contract.display_contract.missing_metric_value, 'blank');
  assert.deepEqual(resolveReportIds('店铺健康诊断快照', loaded), ['shop_health_snapshot']);
  assert.deepEqual(resolveReportIds('category:shop_health_diagnostics', loaded), ['shop_health_snapshot']);
  assert.deepEqual(resolveReportIds('店铺健康专用', loaded), ['shop_health_snapshot']);
  assert.throws(() => resolveReportIds('all', loaded), { code: 'report_alias_unknown' });
  assert.throws(() => resolveReportIds('default', loaded), { code: 'report_alias_unknown' });
});

test('real shop health runner writes MD headers and publishes current snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-health-slice-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bodies(); const spec = realSpec();
  const result = await runHealth(root, Object.entries(source).map(([key, body]) => response(key, body)));
  assert.equal(result.status, 'success'); assert.equal(result.row_count, 3);
  const runnerSheet = readFirstWorksheet(fs.readFileSync(result.output_file));
  assert.deepEqual(runnerSheet.headers, spec.headers); assert.equal(runnerSheet.rows.length, 4);
  const shopRoot = path.join(root, 'shop');
  const published = publishGeneratedXlsx({ spec, sourceFile: result.output_file, shopRoot, variables: { time_file: '当前快照.xlsx' }, taskId: 'shop-health' });
  const expected = path.join(shopRoot, '店铺数据', '店铺健康快照', '当前快照.xlsx');
  assert.equal(published.status, 'success'); assert.equal(published.output_file, expected); assert.equal(published.data_row_count, 3);
  assert.equal(published.sha256, crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex'));
});

test('shop health metrics may contain zero groups while fixed rows remain successful', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-health-fixed-rows-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bodies(); source.metrics.data.metric_groups = [];
  const result = await runHealth(root, Object.entries(source).map(([key, body]) => response(key, body)));
  assert.equal(result.row_count, 2);
});

test('shop health preserves an official metric with an omitted current value as a blank cell', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-health-missing-value-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bodies(); delete source.metrics.data.metric_groups[0].metrics[0].value;
  const result = await runHealth(root, Object.entries(source).map(([key, body]) => response(key, body)));
  const sheet = readFirstWorksheet(fs.readFileSync(result.output_file));
  assert.equal(result.row_count, 3);
  assert.equal(sheet.rows[3][3] ?? '', '');
});

test('shop health runner fails closed on identity missing sources and malformed business data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-health-invalid-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = bodies(); const valid = Object.entries(source).map(([key, body]) => response(key, body));
  await assert.rejects(runHealth(root, [response('score', source.score, '999'), response('overview', source.overview), response('metrics', source.metrics)]), { code: 'shop_health_identity_mismatch' });
  await assert.rejects(runHealth(root, valid.filter((item) => !item.url().includes(realSpec().api_contract.response_paths.metrics)), { requireReady: false }), { code: 'shop_health_source_unavailable' });
  await assert.rejects(runHealth(root, [response('score', { code: 0, data: { score: null } }), response('overview', source.overview), response('metrics', source.metrics)]), { code: 'shop_health_score_incomplete' });
  await assert.rejects(runHealth(root, [response('score', source.score), response('overview', { code: 0, data: { ...source.overview.data, violation_score: 'bad' } }), response('metrics', source.metrics)]), { code: 'shop_health_overview_incomplete' });
  await assert.rejects(runHealth(root, [response('score', source.score), response('overview', source.overview), response('metrics', { code: 0, data: { metric_groups: null } })]), { code: 'shop_health_metrics_incomplete' });
  const blankMetric = structuredClone(source.metrics); blankMetric.data.metric_groups[0].metrics[0].title = '';
  await assert.rejects(runHealth(root, [response('score', source.score), response('overview', source.overview), response('metrics', blankMetric)]), { code: 'shop_health_metrics_incomplete' });
  const invalidMetric = structuredClone(source.metrics); invalidMetric.data.metric_groups[0].metrics[0].value = 'bad';
  await assert.rejects(runHealth(root, [response('score', source.score), response('overview', source.overview), response('metrics', invalidMetric)]), { code: 'shop_health_metrics_incomplete' });
});

test('shop health report spec and shop identity fail before browser connection', async () => {
  await assert.rejects(exportShopHealthSnapshot({}, {}), { code: 'shop_health_report_spec_invalid' });
  await assert.rejects(exportShopHealthSnapshot({ reportSpec: realSpec(), shop: { seller_id: 'invalid' } }, {}), { code: 'shop_health_identity_unavailable' });
});

test('shop health publisher rejects header-only output', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-health-zero-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = realSpec();
  const empty = path.join(root, 'empty.xlsx'); writeWorkbook(empty, [spec.headers]);
  const published = publishGeneratedXlsx({ spec, sourceFile: empty, shopRoot: path.join(root, 'shop'), variables: { time_file: '当前快照.xlsx' }, taskId: 'shop-health-zero', trustedZero: true });
  assert.deepEqual(published, { status: 'failed', reason_code: 'no_data_not_applicable' });
});

test('shop health entry response paths and capture timeouts are driven by MD rules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-health-sentinel-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = structuredClone(realSpec()); spec.api_contract.entry_path = '/sentinel-health'; spec.api_contract.response_paths = { score: '/sentinel-score', overview: '/sentinel-overview', metrics: '/sentinel-metrics' }; Object.assign(spec.api_contract, { capture_timeout_ms: 6543, poll_interval_ms: 9 }); spec.providers.local.api_contract = spec.api_contract;
  const source = bodies(); const responses = Object.entries(source).map(([key, body]) => response(key, body, SELLER_ID, spec)); const mock = mockBrowser(responses); let options;
  const result = await exportShopHealthSnapshot({ a: { shop_alias: '店铺' }, b: { seller_page_url: SELLER_URL }, shop: { seller_id: SELLER_ID }, reportSpec: spec, providerSpec: spec.providers.local, outputDir: path.join(root, 'runner') }, { browser: mock.browser, browserContext: mock.browserContext, waitForCapture: async (_page, ready, value) => { options = value; assert.equal(ready(), true); } });
  assert.equal(result.row_count, 3); assert.deepEqual(mock.paths, ['/sentinel-health']); assert.deepEqual(options, { timeoutMs: 6543, pollMs: 9 });
});
