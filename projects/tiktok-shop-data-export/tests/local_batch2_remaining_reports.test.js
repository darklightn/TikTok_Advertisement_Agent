'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { loadReportMd } = require('../scripts/load-report-md');
const growth = require('../scripts/routes/local/shop_product_growth_opportunity_snapshot');

const ROOT = path.resolve(__dirname, '..');
const SELLER = '7496176775586483191';

function response(url, body) { return { url:() => url, status:() => 200, body:async () => Buffer.from(JSON.stringify(body)) }; }
function harness(fetch) { const page = { url:() => 'https://seller-ph.tiktok.com/home', request:{ fetch } }; const context = { pages:() => [page] }; const browser = { isConnected:() => true, contexts:() => [context] }; return { browser, browserContext:context, skillRoot:ROOT }; }
function input(spec, outputDir) { return { b:{ seller_page_url:'https://seller-ph.tiktok.com/home' }, shop:{ seller_id:SELLER, provider_id:'local' }, reportSpec:spec, providerSpec:spec.providers.local, outputDir }; }

test('Batch 2 remaining provider classifications reflect current evidence', () => {
  const loaded = loadReportMd(); const spec = loaded.specs.shop_product_growth_opportunity_snapshot;
  assert.equal(Object.values(loaded.specs).reduce((sum, item) => sum + Object.keys(item.providers).length, 0), 46);
  assert.deepEqual(Object.keys(spec.providers), ['cross_border','local']); assert.equal(spec.providers.local.response_origin, 'https://seller-ph.tiktok.com');
  assert.notEqual(spec.providers.local.runner, spec.providers.cross_border.runner); assert.deepEqual(Object.keys(loaded.specs.affiliate_center_performance.providers), ['cross_border','local']);
  const source = fs.readFileSync(path.join(ROOT, spec.providers.local.runner), 'utf8'); assert.doesNotMatch(source, /routes[\\/]common[\\/]|routes[\\/]cross_border[\\/]|providers\.cross_border/u);
});

test('local growth fully paginates, emits trusted zero, and rejects incomplete identity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-batch2-remaining-')); t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const spec = structuredClone(loadReportMd().specs.shop_product_growth_opportunity_snapshot); spec.providers.local.api_contract.page_size = 1; const pages = [];
  const live = harness(async (url, options) => { const page = options.data.page_num; pages.push(page); return response(url, { code:0, data:{ total:2, products:[{ product_id:String(100 + page), future_metadata:{ page } }] } }); });
  const success = await growth.run(input(spec, path.join(root, 'success')), live); assert.equal(success.status, 'success'); assert.equal(success.row_count, 2); assert.deepEqual(pages, [1,2]);
  const zero = await growth.run(input(loadReportMd().specs.shop_product_growth_opportunity_snapshot, path.join(root, 'zero')), harness(async (url) => response(url, { code:0, data:{ total:0, products:[] } })));
  assert.equal(zero.status, 'no_data'); assert.equal(zero.row_count, 0); assert.equal(zero.no_data_evidence, 'official_api_zero_total');
  const badDir = path.join(root, 'bad'); await assert.rejects(growth.run(input(loadReportMd().specs.shop_product_growth_opportunity_snapshot, badDir), harness(async (url) => response(url, { code:0, data:{ total:1, products:[{ product_id:'bad' }] } }))), { code:'shop_product_growth_pagination_incomplete' }); assert.equal(fs.existsSync(badDir), false);
});
