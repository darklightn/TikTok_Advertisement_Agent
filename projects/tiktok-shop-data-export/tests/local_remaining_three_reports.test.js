'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { loadReportMd } = require('../scripts/load-report-md');
const { writeWorkbook } = require('../scripts/common/xlsx_writer');
const daily = require('../scripts/routes/local/shop_product_daily_performance');
const analytics = require('../scripts/routes/local/product_analytics_performance');
const affiliate = require('../scripts/routes/local/affiliate_center_performance');

const ROOT = path.resolve(__dirname, '..');
const SELLER = '7496176775586483191';
const SELLER_ORIGIN = 'https://seller-ph.tiktok.com';

function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-remaining-three-')); t.after(() => fs.rmSync(root, { recursive:true, force:true })); return root; }
function input(spec, outputDir) { return { a:{}, b:{ seller_page_url:`${SELLER_ORIGIN}/home` }, shop:{ seller_id:SELLER, provider_id:'local' }, reportSpec:spec, providerSpec:spec.providers.local, outputDir, startDate:'2026-08-17', endDate:'2026-08-17' }; }
function stream(buffer) { return { async *[Symbol.asyncIterator]() { yield buffer; } }; }
function workbook(root, name, dataStartRow) { const file = path.join(root, name); writeWorkbook(file, [...Array.from({ length:dataStartRow - 1 }, (_, index) => [`metadata-${index}`]), ['business-row']]); return fs.readFileSync(file); }

test('the remaining three reports declare independent local provider runners', () => {
  const loaded = loadReportMd(); const ids = ['shop_product_daily_performance','product_analytics_performance','affiliate_center_performance'];
  assert.equal(Object.values(loaded.specs).reduce((sum, spec) => sum + Object.keys(spec.providers).length, 0), 46);
  for (const id of ids) {
    const spec = loaded.specs[id]; assert.deepEqual(Object.keys(spec.providers), ['cross_border','local']); assert.notEqual(spec.providers.cross_border.runner, spec.providers.local.runner);
    const source = fs.readFileSync(path.join(ROOT, spec.providers.local.runner), 'utf8'); assert.doesNotMatch(source, /routes[\\/]cross_border[\\/]|routes[\\/]common[\\/]|providers\.cross_border/u);
  }
  assert.equal(loaded.specs.shop_product_daily_performance.providers.local.api_contract.page_size, 100);
  assert.equal(loaded.specs.product_analytics_performance.providers.local.response_origin, SELLER_ORIGIN);
  assert.equal(loaded.specs.affiliate_center_performance.providers.local.origin, 'https://affiliate.tiktok.com');
});

test('local daily API and both official downloads complete their evidence-backed success paths', async (t) => {
  const root = temporary(t); const loaded = loadReportMd();
  const sellerPage = { url:() => `${SELLER_ORIGIN}/home` }; const sellerContext = { pages:() => [sellerPage] }; const sellerBrowser = { isConnected:() => true, contexts:() => [sellerContext] };
  const dailySpec = loaded.specs.shop_product_daily_performance; const dailyCalls = [];
  const dailyResult = await daily.run(input(dailySpec, path.join(root, 'daily')), { browser:sellerBrowser, browserContext:sellerContext, skillRoot:ROOT, request:async (_live, request) => {
    const target = new URL(request.url); assert.equal(target.origin, SELLER_ORIGIN); for (const name of dailySpec.providers.local.seller_query_names) assert.equal(target.searchParams.get(name), SELLER);
    const channel = request.body.request.search.channel_type; const page = request.body.request.list_control.pagination.page; dailyCalls.push([channel,page]); const first = page === 0;
    return { http_status:200, final_url:target.href, body:{ code:0, data:{ items:[{ meta:{ product_id:first ? '1731835788889589751' : '1731835788889589752' }, stats_v3:{ channel, page } }], list_control:{ next_pagination:{ total:2, total_page:2, has_more:first, next_page:first ? 7 : 8 } } } } };
  } });
  assert.equal(dailyResult.status, 'success'); assert.equal(dailyResult.artifacts.length, 5); assert.deepEqual(dailyCalls, [[0,0],[0,7],[1,0],[1,7],[2,0],[2,7],[3,0],[3,7],[4,0],[4,7]]); assert.deepEqual(dailyResult.artifacts.map((item) => item.row_count), [2,2,2,2,2]);

  const analyticsBytes = workbook(root, 'analytics.xlsx', 5); let analyticsUrl = `${SELLER_ORIGIN}/home`; let analyticsClicks = 0;
  const analyticsButton = { waitFor:async () => {}, count:async () => 1, isVisible:async () => true, isEnabled:async () => true, click:async () => { analyticsClicks += 1; } };
  const analyticsRules = loaded.specs.product_analytics_performance.providers.local.official_validation; const analyticsResponseUrl = new URL(analyticsRules.list_endpoint, SELLER_ORIGIN); for (const name of analyticsRules.seller_queries) analyticsResponseUrl.searchParams.set(name, SELLER);
  const analyticsResponse = { url:() => analyticsResponseUrl.href, status:() => 200, request:() => ({ method:() => analyticsRules.list_method }), json:async () => ({ code:0, data:{ items:[{}], list_control:{ next_pagination:{ total:1, has_more:false, total_page:1 } } } }) };
  const analyticsPage = { url:() => analyticsUrl, goto:async (url) => { analyticsUrl = url; }, waitForResponse:async (predicate) => { assert.equal(predicate(analyticsResponse), true); return analyticsResponse; }, locator:() => analyticsButton, waitForEvent:async () => ({ createReadStream:async () => stream(analyticsBytes) }) };
  const analyticsContext = { pages:() => [analyticsPage] }; const analyticsBrowser = { isConnected:() => true, contexts:() => [analyticsContext] }; fs.mkdirSync(path.join(root, 'analytics-stage'));
  const analyticsResult = await analytics.run(input(loaded.specs.product_analytics_performance, path.join(root, 'analytics-stage')), { browser:analyticsBrowser, browserContext:analyticsContext, skillRoot:ROOT, currencyText:'₱' });
  assert.equal(analyticsResult.status, 'success'); assert.equal(analyticsResult.data_row_count, 1); assert.equal(analyticsClicks, 1); assert.deepEqual(fs.readFileSync(analyticsResult.output_file), analyticsBytes);

  const affiliateBytes = workbook(root, 'affiliate.xlsx', 3); const pages = [sellerPage]; let affiliateUrl = 'about:blank'; let affiliateClicks = 0;
  const regionCandidates = { count:async () => 1 }; let affiliateButton; const region = { locator:(selector) => selector.startsWith('button') ? affiliateButton : { filter:() => regionCandidates }, innerText:async () => '₱ positive data' };
  affiliateButton = { waitFor:async () => {}, count:async () => 1, isVisible:async () => true, isEnabled:async () => true, isDisabled:async () => false, click:async () => { affiliateClicks += 1; } };
  const affiliateSpec = loaded.specs.affiliate_center_performance; const affiliateRules = affiliateSpec.providers.local.official_validation; const taskId = 'A1z9';
  const createUrl = new URL(affiliateRules.create_endpoint, affiliateSpec.providers.local.origin); const createResponse = { url:() => createUrl.href, status:() => 200, request:() => ({ method:() => 'POST' }), json:async () => ({ code:0, data:{ task_id:taskId } }) };
  const exportUrl = new URL(affiliateRules.export_endpoint, affiliateSpec.providers.local.origin); exportUrl.searchParams.set(affiliateRules.task_query, taskId); exportUrl.searchParams.set(affiliateRules.seller_query, SELLER); exportUrl.searchParams.set(affiliateRules.entry_query_fields.shop_region, affiliateRules.shop_region);
  const exportRequest = { url:() => exportUrl.href, method:() => 'GET' };
  const affiliatePage = { url:() => affiliateUrl, goto:async (url) => { affiliateUrl = url; }, locator:() => affiliateButton, waitForResponse:async (predicate) => { assert.equal(predicate(createResponse), true); return createResponse; }, waitForRequest:async (predicate) => { assert.equal(predicate(exportRequest), true); return exportRequest; }, waitForEvent:async () => ({ createReadStream:async () => stream(affiliateBytes) }), close:async () => {} };
  const affiliateContext = { pages:() => pages, newPage:async () => { pages.push(affiliatePage); return affiliatePage; } }; const affiliateBrowser = { isConnected:() => true, contexts:() => [affiliateContext] }; fs.mkdirSync(path.join(root, 'affiliate-stage'));
  const affiliateResult = await affiliate.run(input(affiliateSpec, path.join(root, 'affiliate-stage')), { browser:affiliateBrowser, browserContext:affiliateContext, skillRoot:ROOT, dismissBlockingOverlay:async () => {}, navigateAffiliate:async () => { const target=new URL('/insights/transaction-analysis',affiliateSpec.providers.local.origin);target.searchParams.set(affiliateRules.entry_query_fields.shop_id,SELLER);target.searchParams.set(affiliateRules.entry_query_fields.shop_region,affiliateRules.shop_region);affiliateUrl=target.href;pages.push(affiliatePage);return affiliatePage; }, resolveDetailsCard:async () => region, applyDateRange:async () => '2026/8/17 - 2026/8/17' });
  assert.equal(affiliateResult.status, 'success'); assert.equal(affiliateResult.data_row_count, 1); assert.equal(affiliateResult.task_id, taskId); assert.equal(affiliateClicks, 1); assert.deepEqual(fs.readFileSync(affiliateResult.output_file), affiliateBytes);
});
