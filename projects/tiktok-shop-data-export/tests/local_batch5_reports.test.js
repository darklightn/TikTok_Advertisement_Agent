'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');
const { loadReportMd } = require('../scripts/load-report-md');

const IDS = [
  'gmvmax_campaign_current_configuration_snapshot',
  'gmvmax_campaign_change_log',
  'gmvmax_campaign_recommendation_snapshot',
];
const SELLER = '7496176775586483191';
const ADVERTISER = '7672301067320934401';
const BC = '7500519367638466576';
const CAMPAIGN = '1873250540739682';

function response(url, body) {
  return { url: () => url, status: () => 200, body: async () => Buffer.from(JSON.stringify(body)) };
}
function campaignBody() {
  return { code: 0, data: { table: [{ campaign_id: CAMPAIGN, campaign_name: 'Campaign' }], pagination: { total_count: 1, page_count: 1, page: 1 } } };
}
function input(spec, outputDir) {
  return {
    reportSpec: spec,
    providerSpec: spec.providers.local,
    outputDir,
    startDate: '2026-08-17',
    endDate: '2026-08-17',
    campaignRef: CAMPAIGN,
    b: { seller_page_url: 'https://seller-ph.tiktok.com/homepage' },
    shop: { seller_id: SELLER, provider_id: 'local' },
    advertiserId: ADVERTISER,
    advertiserName: 'Advertiser',
    advertiserCurrency: 'USD',
    businessCenterId: BC,
  };
}
function harness(fetch) {
  const page = { url: () => 'https://seller-ph.tiktok.com/homepage', request: { fetch } };
  const context = { pages: () => [page] };
  const browser = { isConnected: () => true, contexts: () => [context] };
  return { browser, browserContext: context, skillRoot: path.resolve(__dirname, '..'), clock: () => new Date('2026-08-17T00:00:00Z') };
}

test('Batch 5 declares independent local provider runners', () => {
  const loaded = loadReportMd();
  assert.equal(Object.values(loaded.specs).reduce((sum, spec) => sum + Object.keys(spec.providers).length, 0), 46);
  for (const reportId of IDS) {
    const spec = loaded.specs[reportId];
    assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']);
    assert.equal(spec.providers.local.response_origin, 'https://seller-ph.tiktok.com');
    assert.notEqual(spec.providers.local.runner, spec.providers.cross_border.runner);
    const source = fs.readFileSync(path.join(__dirname, '..', spec.providers.local.runner), 'utf8');
    assert.doesNotMatch(source, /routes[\\/]common[\\/]|routes[\\/]cross_border[\\/]|providers\.cross_border/u);
  }
});

test('Batch 5 local runners bind frozen seller and advertiser and preserve trusted zero contracts', async (t) => {
  const loaded = loadReportMd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-batch5-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const reportId of IDS) {
    const spec = loaded.specs[reportId];
    const provider = spec.providers.local;
    const contract = provider.api_contract;
    const calls = [];
    const runner = require(path.join(__dirname, '..', provider.runner));
    const dependencies = harness(async (url, options) => {
      const target = new URL(url);
      calls.push(target);
      assert.equal(target.origin, provider.response_origin);
      assert.equal(target.searchParams.get(contract.request_query.seller), SELLER);
      assert.equal(target.searchParams.get(contract.request_query.advertiser), ADVERTISER);
      if (target.pathname === contract.campaign_endpoint) {
        return response(url, campaignBody());
      }
      if (reportId === 'gmvmax_campaign_current_configuration_snapshot') return response(url, { code: 0, data: { campaign_info: { campaign_id: CAMPAIGN }, ad_info: { campaign_id: CAMPAIGN, shop_id: SELLER } } });
      if (reportId === 'gmvmax_campaign_change_log') return response(url, { code: 0, data: { pagination: { total_count: 0, page_count: 0, page: 1 } } });
      if (reportId === 'gmvmax_campaign_recommendation_snapshot') return response(url, { code: 0, data: { items: [], summary: {} } });
      if (target.pathname === contract.session_list_endpoint) return response(url, { code: 0, data: { pagination: { total_count: 0, page_count: 0, page: 1 } } });
      return response(url, { code: 0, data: {} });
    });
    const result = await runner.run(input(spec, path.join(root, reportId)), reportId === 'gmvmax_campaign_change_log'
      ? { ...dependencies, discoverCampaigns: async () => [{ campaign_id: CAMPAIGN, campaign_name: 'Campaign' }] }
      : dependencies);
    assert.equal(result.provider_id, 'local');
    assert.equal(calls.length > 0, true);
    if (reportId === 'gmvmax_campaign_current_configuration_snapshot') {
      assert.equal(result.status, 'success');
      assert.equal(result.artifacts[0].row_count, 1);
      const sheet = readFirstWorksheet(fs.readFileSync(result.artifacts[0].output_file));
      assert.equal(sheet.rows[1][spec.headers.indexOf('currency')], 'USD');
    } else {
      assert.equal(result.status, 'no_data');
      assert.equal(result.artifacts.every((artifact) => artifact.row_count === 0), true);
    }
  }
});
