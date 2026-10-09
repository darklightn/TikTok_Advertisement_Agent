'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadReportMd } = require('../scripts/load-report-md');

const SUPPORTED = ['shop_product_daily_performance', 'shop_video_performance', 'product_analytics_performance'];
const SELLER = '7496176775586483191';

function response(url, body) { return { url: () => url, status: () => 200, body: async () => Buffer.from(JSON.stringify(body)) }; }
function input(spec, outputDir) { return { reportSpec: spec, providerSpec: spec.providers.local, outputDir, startDate: '2026-08-15', endDate: '2026-08-17', b: { seller_page_url: 'https://seller-ph.tiktok.com/homepage' }, shop: { seller_id: SELLER, provider_id: 'local' } }; }
function harness(fetch) { const page = { url: () => 'https://seller-ph.tiktok.com/homepage', request: { fetch } }; const context = { pages: () => [page] }; const browser = { isConnected: () => true, contexts: () => [context] }; return { browser, browserContext: context, skillRoot: path.resolve(__dirname, '..') }; }
function videoBody(rows, total, pages) { return { code: 0, data: { segments: [{ timed_lists: [{ start: '2026-08-15T00:00:00', end: '2026-08-18T00:00:00', ...(rows === null ? {} : { stats: rows }) }], list_control: { next_pagination: { total, total_page: pages } } }] } }; }

test('Batch 1 enables the evidence-backed local provider runners', () => {
  const loaded = loadReportMd();
  assert.equal(Object.values(loaded.specs).reduce((sum, spec) => sum + Object.keys(spec.providers).length, 0), 46);
  for (const reportId of SUPPORTED) {
    const spec = loaded.specs[reportId];
    assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']);
    assert.equal(spec.providers.local.response_origin, 'https://seller-ph.tiktok.com');
    assert.notEqual(spec.providers.local.runner, spec.providers.cross_border.runner);
    const source = fs.readFileSync(path.join(__dirname, '..', spec.providers.local.runner), 'utf8');
    assert.doesNotMatch(source, /routes[\\/]common[\\/]|routes[\\/]cross_border[\\/]|providers\.cross_border/u);
  }
});

test('local video fully paginates with trusted zero', async (t) => {
  const loaded = loadReportMd(); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-batch1-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoSpec = loaded.specs.shop_video_performance; const videoContract = videoSpec.providers.local.api_contract; const videoPages = [];
  const videoLive = harness(async (url, options) => {
    const target = new URL(url); assert.equal(target.origin, 'https://seller-ph.tiktok.com'); for (const name of videoContract.search_params.seller_query_names) assert.equal(target.searchParams.get(name), SELLER);
    const page = options.data.request.params[0].list_control.pagination.page; videoPages.push(page); return response(url, videoBody([{ shop_id: SELLER, video_meta: { id: `video-${page}` }, revenue: page + 1 }], 2, 2));
  });
  const video = require('../scripts/routes/local/shop_video_performance'); const videoResult = await video.run(input(videoSpec, path.join(root, 'video')), videoLive); assert.equal(videoResult.status, 'success'); assert.equal(videoResult.row_count, 2); assert.deepEqual(videoPages, [0, 1]);
  const zeroLive = harness(async (url) => response(url, videoBody(null, 0, 0))); const zeroResult = await video.run(input(videoSpec, path.join(root, 'video-zero')), zeroLive); assert.equal(zeroResult.status, 'no_data'); assert.equal(zeroResult.row_count, 0);

});
