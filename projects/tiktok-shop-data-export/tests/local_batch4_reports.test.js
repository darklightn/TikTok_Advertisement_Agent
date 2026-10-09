'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadReportMd } = require('../scripts/load-report-md');

const ROOT = path.resolve(__dirname, '..');
const IDS = [
  'gmvmax_campaign_product_performance',
  'gmvmax_campaign_product_creative_performance',
];
const SELLER = '7496176775586483191';
const ADVERTISER = '7672301067320934401';
const BC = '7500519367638466576';

function temporary(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `local-batch4-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function response(url, body) {
  return { status: () => 200, url: () => url, body: async () => Buffer.from(JSON.stringify(body)) };
}
function paged(rows) {
  return { code: 0, data: { table: rows, pagination: { total_count: rows.length, page_count: rows.length ? 1 : 0, page: 1 } } };
}
function harness(fetch) {
  const page = { url: () => 'https://seller-ph.tiktok.com/home', request: { fetch } };
  const context = { pages: () => [page], request: { get: async () => { throw new Error('unexpected download'); } } };
  const browser = { isConnected: () => true, contexts: () => [context] };
  return { browser, context, dependencies: { browser, browserContext: context, skillRoot: ROOT } };
}
function input(spec, outputDir, extra = {}) {
  return {
    reportSpec: spec,
    providerSpec: spec.providers.local,
    outputDir,
    startDate: '2026-08-17',
    endDate: '2026-08-17',
    a: {},
    b: { seller_page_url: 'https://seller-ph.tiktok.com/home' },
    shop: { seller_id: SELLER, provider_id: 'local' },
    advertiserId: ADVERTISER,
    advertiserName: 'Local Advertiser',
    advertiserCurrency: 'USD',
    businessCenterId: BC,
    campaignRef: '101',
    productRef: '501',
    ...extra,
  };
}

test('Batch 4 MD exposes the two retained independent local provider runners', () => {
  const loaded = loadReportMd();
  for (const reportId of IDS) {
    const spec = loaded.specs[reportId];
    assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']);
    assert.equal(spec.providers.local.response_origin, 'https://seller-ph.tiktok.com');
    assert.notEqual(spec.providers.local.runner, spec.providers.cross_border.runner);
    const localSource = fs.readFileSync(path.join(ROOT, spec.providers.local.runner), 'utf8');
    const crossSource = fs.readFileSync(path.join(ROOT, spec.providers.cross_border.runner), 'utf8');
    assert.doesNotMatch(localSource, /routes[\\/]cross_border|providers\.cross_border/u);
    assert.doesNotMatch(crossSource, /routes[\\/]local/u);
    const runner = require(path.join(ROOT, spec.providers.local.runner));
    assert.equal(runner.validateSpec(spec, spec.providers.local, { skillRoot: ROOT }), spec);
  }
});

test('Batch 4 retained local runner consumes seller-ph contracts for trusted zero', async (t) => {
  const loaded = loadReportMd();
  for (const reportId of IDS.filter((id) => id !== 'gmvmax_campaign_product_creative_performance')) {
    const spec = loaded.specs[reportId];
    const rules = spec.providers.local.official_validation;
    const outputDir = temporary(t, reportId);
    const live = harness(async (url, options) => {
      const target = new URL(url);
      assert.equal(target.origin, spec.providers.local.response_origin);
      assert.equal(target.searchParams.get(rules.query_parameters.seller_id), SELLER);
      assert.equal(target.searchParams.get(rules.query_parameters.advertiser_id), ADVERTISER);
      if (target.pathname === rules.campaign_endpoint) return response(url, paged([{ campaign_id: '101', campaign_name: 'Campaign' }]));
      if (target.pathname === rules.product_endpoint) {
        const rows = reportId === 'gmvmax_campaign_product_performance' ? [] : [{ product_id: '501', product_name: 'Product' }];
        return response(url, paged(rows));
      }
      if (target.pathname === rules.creative_endpoint) return response(url, paged([]));
      throw new Error(`unexpected ${target.pathname} ${JSON.stringify(options.data)}`);
    });
    const runner = require(path.join(ROOT, spec.providers.local.runner));
    const result = await runner.run(input(spec, outputDir, reportId === 'gmvmax_campaign_product_performance' ? { productRef: null } : {}), live.dependencies);
    assert.equal(result.status, 'no_data', reportId);
    assert.equal(result.provider_id, 'local');
    assert.equal(result.artifacts.length, 1);
  }

});
