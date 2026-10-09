'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadReportMd } = require('../scripts/load-report-md');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = [
  'advertiser_account_status_snapshot',
  'gmvmax_campaign_overview',
  'gmvmax_campaign_hourly_performance',
  'gmvmax_campaign_performance',
];

test('batch 3 reports declare independent local provider runners', async () => {
  const loaded = loadReportMd();
  for (const reportId of REPORTS) {
    const spec = loaded.specs[reportId];
    assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']);
    const provider = spec.providers.local;
    assert.equal(provider.response_origin, 'https://seller-ph.tiktok.com');
    if (reportId === 'gmvmax_campaign_performance') {
      assert.equal(provider.runner, 'scripts/routes/local/gmvmax_campaign_performance_interval.js');
    } else assert.equal(provider.runner, `scripts/routes/local/${reportId}.js`);
    assert.notEqual(provider.runner, spec.providers.cross_border.runner);
    const source = fs.readFileSync(path.join(ROOT, provider.runner), 'utf8');
    assert.doesNotMatch(source, /routes[\\/]cross_border|provider_id\s*!==\s*'cross_border'/u);
    const runner = require(path.join(ROOT, provider.runner));
    assert.equal(runner.validateSpec(spec, provider, { skillRoot: ROOT }), spec);
    await assert.rejects(() => runner.run({ shop: { provider_id: 'cross_border' } }), { code: 'report_provider_unsupported' });
  }
});
test('local overview delegates to the direct Seller UI download runner', () => {
  const spec=loadReportMd().specs.gmvmax_campaign_overview;const provider=spec.providers.local;
  assert.equal(provider.transport,'seller_ui_direct_download');
  assert.equal(provider.official_validation.entry_path,'/ads-creation/dashboard');
  assert.match(provider.official_validation.export_selector,/export-button/u);
  const source=fs.readFileSync(path.join(ROOT,provider.runner),'utf8');
  assert.match(source,/createRunner\('local'\)/u);
  assert.doesNotMatch(source,/create_endpoint|task_query_endpoint|max_polls/u);
});
