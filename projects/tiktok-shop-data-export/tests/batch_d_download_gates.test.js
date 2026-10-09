'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');

const ROOT = path.resolve(__dirname, '..');
const BATCH_IDS = [
  'product_analytics_performance', 'manage_orders_csv', 'affiliate_center_performance',
  'affiliate_performance_overview', 'gmvmax_campaign_overview',
  'gmvmax_campaign_product_creative_performance',
];

test('Batch F activates Affiliate creator detail and keeps only Affiliate overview outside the router', () => {
  const loaded = loadReportMd();
  assert.equal(Object.keys(loaded.specs).length, 23);
  const declaredEntryCount = Object.values(loaded.specs).filter((spec) => spec.enabled)
    .reduce((total, spec) => total + Object.keys(spec.providers).length, 0);
  assert.equal(declaredEntryCount, 46);
  assert.deepEqual(Object.keys(loaded.specs.inventory_snapshot.providers), ['cross_border', 'local']);
  assert.equal(loaded.specs.affiliate_performance_overview, undefined);
  for (const reportId of BATCH_IDS.filter((id) => id !== 'affiliate_performance_overview')) assert.equal(loaded.specs[reportId].enabled, true);
  assert.equal(loaded.specs.product_ratings_review_list.enabled, true);
  assert.deepEqual(Object.keys(loaded.specs.product_ratings_review_list.providers), ['cross_border', 'local']);
  for (const alias of ['all', 'default']) assert.throws(() => resolveReportIds(alias, loaded), { code: 'report_alias_unknown' });
});

test('Affiliate overview has one non-runtime disabled chapter', () => {
  const candidate = fs.readFileSync(path.join(ROOT, 'references', 'reports', 'affiliate.md'), 'utf8');
  const overview = candidate.slice(candidate.indexOf('## affiliate_performance_overview'));
  assert.match(overview, /^## affiliate_performance_overview$/mu);
  assert.match(overview, /enabled: false/u);
  assert.doesNotMatch(overview, /report-spec:start/u);
});
