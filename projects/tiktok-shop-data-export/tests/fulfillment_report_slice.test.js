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
const {
  exportFulfillmentPerformanceSnapshot,
  rowsFor,
} = require('../scripts/routes/local/fulfillment_performance_snapshot');
const { fulfillmentBodies } = require('./fixtures/fulfillment_performance');

function realSpec() {
  return loadReportMd().specs.fulfillment_performance_snapshot;
}

test('real fulfillment router and report spec resolve only direct and dedicated aliases', () => {
  const loaded = loadReportMd();
  assert.deepEqual(Object.keys(loaded.specs), [
    'fulfillment_performance_snapshot', 'inventory_snapshot', 'shop_health_snapshot',
    'returns_refunds_snapshot', 'shop_promotion_performance', 'shop_creative_hub_video',
    'shop_product_daily_performance', 'shop_video_performance',
    'shop_product_growth_opportunity_snapshot', 'shop_product_commercial_status_snapshot',
    'product_analytics_performance', 'manage_orders_csv', 'product_ratings_review_list',
    'gmvmax_campaign_product_performance',
    'advertiser_account_status_snapshot', 'gmvmax_campaign_hourly_performance',
    'gmvmax_campaign_performance', 'gmvmax_campaign_current_configuration_snapshot',
    'gmvmax_campaign_change_log', 'gmvmax_campaign_recommendation_snapshot', 'gmvmax_campaign_overview',
    'gmvmax_campaign_product_creative_performance', 'affiliate_center_performance',
  ]);
  assert.deepEqual(resolveReportIds('履约表现快照', loaded), ['fulfillment_performance_snapshot']);
  assert.deepEqual(resolveReportIds('category:fulfillment_diagnostics', loaded), ['fulfillment_performance_snapshot']);
  assert.deepEqual(resolveReportIds('履约专用', loaded), ['fulfillment_performance_snapshot']);
  assert.equal(loaded.specs.fulfillment_performance_snapshot.providers.local.api_contract.capture_timeout_ms, 45000);
  assert.throws(() => resolveReportIds('all', loaded), { code: 'report_alias_unknown' });
});

test('real runner uses MD headers and publishes its XLSX atomically', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-slice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = realSpec();
  const bodies = fulfillmentBodies();
  const sellerId = '7494671404273272171';
  const sellerUrl = 'https://seller-ph.tiktok.com/compass/fulfillment';
  const handlers = new Set();
  const responses = Object.entries({
    timeliness: bodies.timeliness,
    metrics: bodies.metrics,
    suggestions: bodies.suggestions,
  }).map(([key, body]) => ({
    url: () => `https://seller-ph.tiktok.com${spec.providers.local.api_contract.response_paths[key]}?oec_seller_id=${sellerId}`,
    request: () => ({ method: () => 'POST' }),
    json: async () => ({ code: 0, ...body }),
  }));
  let reloadCount = 0;
  let gotoCount = 0;
  const page = {
    url: () => sellerUrl,
    on: (event, handler) => { if (event === 'response') handlers.add(handler); },
    off: (event, handler) => { if (event === 'response') handlers.delete(handler); },
    reload: async () => { reloadCount += 1; await Promise.all(responses.flatMap((response) => [...handlers].map((handler) => handler(response)))); },
    goto: async () => { gotoCount += 1; },
  };
  let browserClosed = false;
  const browserContext = { pages: () => [page] };
  const browser = { isConnected: () => true, contexts: () => [browserContext], close: async () => { browserClosed = true; } };
  const runnerResult = await exportFulfillmentPerformanceSnapshot({
    a: { shop_alias: '店铺', cdp_url: 'http://127.0.0.1:9222' },
    b: { seller_page_url: sellerUrl },
    shop: { seller_id: sellerId },
    reportSpec: spec,
    providerSpec: spec.providers.local,
    outputDir: path.join(root, 'runner'),
  }, {
    browser,
    browserContext,
    clock: () => new Date('2026-07-28T00:00:00.000Z'),
    waitForCapture: async (_page, ready) => { assert.equal(ready(), true); },
  });
  assert.equal(browserClosed, false);
  assert.equal(reloadCount, 1);
  assert.equal(gotoCount, 0);
  assert.equal(runnerResult.row_count, 10);
  const runnerSheet = readFirstWorksheet(fs.readFileSync(runnerResult.output_file));
  assert.deepEqual(runnerSheet.headers, spec.headers);
  assert.equal(runnerSheet.rows.length, 11);
  const shopRoot = path.join(root, 'shop');
  const options = { spec, sourceFile: runnerResult.output_file, shopRoot, variables: { time_file: '当前快照.xlsx' } };
  const first = publishGeneratedXlsx({ ...options, taskId: 'fulfillment-1' });
  const expected = path.join(shopRoot, '店铺数据', '履约表现快照', '当前快照.xlsx');
  assert.equal(first.status, 'success');
  assert.equal(first.output_file, expected);
  assert.equal(first.data_row_count, 10);
  assert.equal(first.sha256, crypto.createHash('sha256').update(fs.readFileSync(expected)).digest('hex'));
  const sheet = readFirstWorksheet(fs.readFileSync(expected));
  assert.deepEqual(sheet.headers, spec.headers);
  assert.equal(sheet.headers.length, 16);
  assert.equal(sheet.rows.length, 11);
  const second = publishGeneratedXlsx({ ...options, taskId: 'fulfillment-2' });
  assert.equal(second.status, 'success');
  assert.equal(second.output_file, expected);
  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(fs.readdirSync(path.dirname(expected)).filter((name) => name.endsWith('.tmp.xlsx')), []);
});

test('fulfillment runner rejects missing or mismatched report specs before browser access', async () => {
  await assert.rejects(exportFulfillmentPerformanceSnapshot({}, {}), { code: 'fulfillment_report_spec_invalid' });
  await assert.rejects(exportFulfillmentPerformanceSnapshot({ reportSpec: { report_id: 'other', headers: ['x'] } }, {}), { code: 'fulfillment_report_spec_invalid' });
  assert.throws(() => rowsFor(null, {}, {}, {}, '', {}), { code: 'fulfillment_report_headers_missing' });
});

test('not-applicable fulfillment spec rejects a zero-row workbook even when zero is trusted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-zero-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = realSpec();
  const sourceFile = path.join(root, 'source.xlsx');
  const shopRoot = path.join(root, 'shop');
  writeWorkbook(sourceFile, [spec.headers]);
  const result = publishGeneratedXlsx({ spec, sourceFile, shopRoot, variables: { time_file: '当前快照.xlsx' }, taskId: 'fulfillment-zero', trustedZero: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason_code, 'no_data_not_applicable');
  assert.equal(fs.existsSync(path.join(shopRoot, '店铺数据', '履约表现快照', '当前快照.xlsx')), false);
});

test('fulfillment entry response paths labels and capture timeouts are driven by MD rules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fulfillment-sentinel-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = structuredClone(realSpec()); Object.assign(spec.providers.local.api_contract, { entry_path: '/sentinel-fulfillment', response_paths: { timeliness: '/sentinel-time', metrics: '/sentinel-metrics', suggestions: '/sentinel-suggestions' }, capture_timeout_ms: 7654, poll_interval_ms: 11 }); spec.providers.local.api_contract.timeliness_metric_labels.Stocking2Delivery = 'MD sentinel label';
  const bodies = fulfillmentBodies(); const handlers = new Set(); const gotos = [];
  const responses = Object.entries({ timeliness: bodies.timeliness, metrics: bodies.metrics, suggestions: bodies.suggestions }).map(([key, body]) => ({ url: () => `https://seller-ph.tiktok.com${spec.providers.local.api_contract.response_paths[key]}?oec_seller_id=88`, request: () => ({ method: () => 'POST' }), json: async () => ({ code: 0, ...body }) }));
  const page = { url: () => 'https://seller-ph.tiktok.com/home', on: (_event, handler) => handlers.add(handler), off: (_event, handler) => handlers.delete(handler), goto: async (url) => { gotos.push(url); await Promise.all(responses.flatMap((response) => [...handlers].map((handler) => handler(response)))); } };
  const browserContext = { pages: () => [page] }; const browser = { isConnected: () => true, contexts: () => [browserContext] }; let options;
  const result = await exportFulfillmentPerformanceSnapshot({ a: { shop_alias: '店铺' }, b: { seller_page_url: page.url() }, shop: { seller_id: '88' }, reportSpec: spec, providerSpec: spec.providers.local, outputDir: path.join(root, 'runner') }, { browser, browserContext, waitForCapture: async (_page, ready, value) => { options = value; assert.equal(ready(), true); } });
  assert.equal(new URL(gotos[0]).pathname, '/sentinel-fulfillment'); assert.deepEqual(options, { timeoutMs: 7654, pollMs: 11 });
  assert.equal(readFirstWorksheet(fs.readFileSync(result.output_file)).rows.flat().includes('MD sentinel label'), true);
});
