'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadReportMd } = require('../scripts/load-report-md');
const { publishOfficialDownload } = require('../scripts/common/output-publish');
const cross = require('../scripts/routes/cross_border/product_ratings_review_list');
const local = require('../scripts/routes/local/product_ratings_review_list');

const START = '2026-08-17';
const END = '2026-08-17';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratings-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function response(origin, endpoint, method, body) {
  const request = { method: () => method, postData: () => null };
  return { url: () => `${origin}${endpoint}`, request: () => request, status: () => 200, json: async () => body };
}

function harness(root, spec, providerId, options = {}) {
  const rules = spec.providers[providerId].official_validation;
  const baselineId = options.baselineId ?? (providerId === 'local' ? 33 : 0);
  const newId = baselineId + 1;
  const queue = [response(rules.response_origin, rules.job_endpoint, 'GET', { code: 0, job_id: baselineId })];
  if ((options.total ?? 7) > 0) {
    queue.push(response(rules.response_origin, rules.start_endpoint, 'POST', { code: 0 }));
    if (options.ambiguous) {
      queue.push(response(rules.response_origin, rules.job_endpoint, 'GET', { code: 0, job_id: newId, is_authorized: false }));
      queue.push(response(rules.response_origin, rules.job_endpoint, 'GET', { code: 0, job_id: newId + 1, is_authorized: true, file_url: 'https://download.example/ratings.csv' }));
    } else queue.push(response(rules.response_origin, rules.job_endpoint, 'GET', { code: 0, job_id: newId, is_authorized: true, file_url: options.fileUrl || 'https://download.example/ratings.csv' }));
  }
  const counts = { gotos: 0, clicks: 0, downloads: 0 };
  const downloadTargets = []; let dateClicks = 0; let resolveDateResponse = null;
  let currentUrl = `${rules.seller_origin}/home`;
  const button = { count: async () => 1, isVisible: async () => true, isEnabled: async () => true, click: async () => { counts.clicks += 1; } };
  const page = {
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; counts.gotos += 1; },
    getByRole: () => button,
    getByPlaceholder: () => ({ click: async () => {} }),
    locator: () => {
      const panel = { locator: (selector) => selector === rules.date_header_selector
        ? { innerText: async () => '2026年8月' }
        : selector === rules.date_control_selector
          ? { nth: () => ({ click: async () => {} }) }
          : { filter: () => ({ count: async () => 1, click: async () => { dateClicks += 1; if (dateClicks === 2 && resolveDateResponse) resolveDateResponse(); } }) } };
      return { count: async () => 2, first: () => panel, last: () => panel };
    },
    waitForResponse: async (predicate) => {
      const index = queue.findIndex((item) => predicate(item));
      if (index >= 0) return queue.splice(index, 1)[0];
      if (options.realDateBinding) {
        const dateResponse = response(rules.response_origin, rules.list_endpoint, rules.list_method, { code: 0, data: { total: options.total ?? 7 } });
        if (predicate(dateResponse)) return new Promise((resolve) => { resolveDateResponse = () => resolve(dateResponse); });
      }
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    },
  };
  const bytes = options.bytes || Buffer.from('任意表头\r\n"一条包含\r\n换行的数据"\r\n', 'utf8');
  const download = {
    status: () => 200, url: () => 'https://download.example/actual-any-name.csv',
    headers: () => ({ 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="unexpected.csv"' }),
    body: async () => bytes,
  };
  const browserContext = { pages: () => [page], request: { get: async (url) => { counts.downloads += 1; downloadTargets.push(url); return download; } } };
  const browser = { isConnected: () => true, contexts: () => [browserContext] };
  const outputDir = path.join(root, 'stage'); fs.mkdirSync(outputDir);
  const identity = { browser_id: '7', cdp_url: 'http://127.0.0.1:9222' };
  const input = {
    a: { ...identity, status: 'ready', shop_alias: '测试店', seller_id: '88' },
    b: { ...identity, status: 'operable', requested_shop_alias: '测试店', seller_page_url: `${rules.seller_origin}/home?shop_region=PH` },
    shop: { ...identity, status: 'identified', shop_alias: '测试店', provider_id: providerId, seller_id: '88' },
    reportSpec: spec, providerSpec: spec.providers[providerId], startDate: START, endDate: END, outputDir,
  };
  const dependencies = { browser, browserContext, skillRoot: path.resolve(__dirname, '..') };
  if (!options.realDateBinding) dependencies.applyDateRange = async () => options.total ?? 7;
  return { counts, dateClicks: () => dateClicks, downloadTargets, input, dependencies, bytes };
}

test('real MD enables two independent ratings providers in the fully enabled catalog', () => {
  const loaded = loadReportMd(); const spec = loaded.specs.product_ratings_review_list;
  assert.equal(spec.enabled, true); assert.deepEqual(Object.keys(spec.providers), ['cross_border', 'local']);
  assert.notEqual(spec.providers.cross_border.runner, spec.providers.local.runner);
  for (const provider of ['cross_border', 'local']) {
    const source = fs.readFileSync(path.join(__dirname, '..', spec.providers[provider].runner), 'utf8');
    assert.doesNotMatch(source, /routes[\\/]common[\\/]product_ratings|routes[\\/](?:cross_border|local)[\\/]product_ratings/u);
  }
  assert.equal(spec.output_granularity, 'request_range'); assert.equal(Object.hasOwn(spec, 'segment_publication'), false);
  assert.equal(Object.values(loaded.specs).filter((item) => item.enabled).length, 23);
  assert.equal(Object.values(loaded.specs).filter((item) => !item.enabled).length, 0);
  assert.equal(Object.values(loaded.specs).filter((item) => item.enabled).reduce((sum, item) => sum + Object.keys(item.providers).length, 0), 46);
  assert.deepEqual(Object.values(loaded.specs).filter((item) => !item.enabled).map((item) => item.report_id), []);
});

test('ratings export uses the 商品评价 alias and output directory', () => {
  const loaded = loadReportMd(); const spec = loaded.specs.product_ratings_review_list;
  const route = loaded.router.reports.find((report) => report.report_id === spec.report_id);
  assert.equal(spec.output_path_template, '店铺数据/商品评价/{{time_file}}');
  assert.equal(route.aliases.includes('商品评价'), true);
  assert.equal(route.aliases.includes('商品评价明细'), false);
});

test('provider validation accepts future metadata but rejects a missing consumed rule', () => {
  const spec = structuredClone(loadReportMd().specs.product_ratings_review_list);
  spec.providers.local.official_validation.future_metadata = { ignored: true };
  assert.doesNotThrow(() => local.validateSpec(spec, spec.providers.local, { skillRoot: path.resolve(__dirname, '..') }));
  delete spec.providers.local.official_validation.job_endpoint;
  assert.throws(() => local.validateSpec(spec, spec.providers.local, { skillRoot: path.resolve(__dirname, '..') }), { code: 'ratings_report_spec_invalid' });
});

test('local binds the response caused by the final date click even when postData is null and completes', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list; const root = temporaryRoot(t);
  const live = harness(root, spec, 'local', { realDateBinding: true, total: 39 });
  const result = await local.run(live.input, live.dependencies);
  assert.equal(result.status, 'success'); assert.equal(result.data_row_count, 1);
  assert.equal(live.dateClicks(), 2); assert.deepEqual(live.counts, { gotos: 1, clicks: 1, downloads: 1 });
});

test('cross binds the response caused by the final date click with null postData and completes', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list; const root = temporaryRoot(t);
  const live = harness(root, spec, 'cross_border', { realDateBinding: true, total: 7 });
  const result = await cross.run(live.input, live.dependencies);
  assert.equal(result.status, 'success'); assert.equal(result.data_row_count, 1);
  assert.equal(live.dateClicks(), 2); assert.deepEqual(live.counts, { gotos: 1, clicks: 1, downloads: 1 });
});

test('both providers preserve arbitrary official CSV bytes and publish one stable range file', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list;
  for (const [providerId, runner] of [['cross_border', cross], ['local', local]]) {
    const root = temporaryRoot(t); const live = harness(root, spec, providerId);
    const result = await runner.run(live.input, live.dependencies);
    assert.equal(result.status, 'success'); assert.equal(result.data_row_count, 1);
    assert.equal(result.task_id, providerId === 'local' ? '34' : '1');
    assert.equal(fs.readFileSync(result.output_file).equals(live.bytes), true);
    assert.deepEqual(live.counts, { gotos: 1, clicks: 1, downloads: 1 });
    const shopRoot = path.join(root, 'shop');
    const published = publishOfficialDownload({
      spec, sourceFile: result.output_file, expectedSha256: result.sha256, status: result.status,
      dataRowCount: result.data_row_count, shopRoot, taskId: `ratings-${providerId}`,
      variables: { start_date: START, end_date: END, time_file: `${START}_至_${END}.csv` },
    });
    assert.equal(published.status, 'success'); assert.equal(fs.readFileSync(published.output_file).equals(live.bytes), true);
    assert.equal(path.basename(published.output_file), `${START}_至_${END}.csv`);
  }
});

test('trusted list total zero generates the existing empty CSV without export or download', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list; const root = temporaryRoot(t);
  const live = harness(root, spec, 'local', { total: 0 }); const result = await local.run(live.input, live.dependencies);
  assert.equal(result.status, 'no_data'); assert.equal(result.row_count, 0); assert.equal(result.no_data_evidence, spec.no_data_rule);
  assert.equal(fs.readFileSync(result.output_file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), true);
  assert.deepEqual(live.counts, { gotos: 1, clicks: 0, downloads: 0 });
});

test('both providers normalize an official scheme-less host/path before download', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list;
  for (const [providerId, runner] of [['cross_border', cross], ['local', local]]) {
    const root = temporaryRoot(t); const live = harness(root, spec, providerId, { fileUrl: 'seller-id.tiktok.com/easesafe/ratings.csv?sign=abc' });
    const result = await runner.run(live.input, live.dependencies);
    assert.equal(result.status, 'success');
    assert.deepEqual(live.downloadTargets, ['https://seller-id.tiktok.com/easesafe/ratings.csv?sign=abc']);
  }
});

test('official download URL normalization rejects unsafe or malformed values', () => {
  assert.equal(cross.normalizeOfficialUrl('https://download.example/ratings.csv').href, 'https://download.example/ratings.csv');
  assert.equal(local.normalizeOfficialUrl('seller-id.tiktok.com/easesafe/ratings.csv').href, 'https://seller-id.tiktok.com/easesafe/ratings.csv');
  for (const value of ['', ' http://download.example/a.csv', 'http://download.example/a.csv',
    'https://user:pass@download.example/a.csv', '/relative.csv', '//download.example/a.csv',
    'download.example/a file.csv', 'localhost/a.csv', 'javascript:alert(1)']) {
    assert.throws(() => cross.normalizeOfficialUrl(value), { code: 'review_export_file_invalid' });
  }
});

test('positive total with header-only official CSV fails without replacing formal bytes', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list; const root = temporaryRoot(t);
  const formal = path.join(root, 'formal.csv'); fs.writeFileSync(formal, 'old-formal');
  const live = harness(root, spec, 'cross_border', { bytes: Buffer.from('changed header\r\n') });
  await assert.rejects(() => cross.run(live.input, live.dependencies), { code: 'official_data_row_count_mismatch' });
  assert.equal(fs.readFileSync(formal, 'utf8'), 'old-formal'); assert.deepEqual(fs.readdirSync(live.input.outputDir), []);
  assert.deepEqual(live.counts, { gotos: 1, clicks: 1, downloads: 1 });
});

test('provider origin mismatch fails before navigation HTTP or export', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list; const root = temporaryRoot(t);
  const live = harness(root, spec, 'local'); live.input.b.seller_page_url = 'https://seller.tiktokshopglobalselling.com/home';
  await assert.rejects(() => local.run(live.input, live.dependencies), { code: 'provider_binding_invalid' });
  assert.deepEqual(live.counts, { gotos: 0, clicks: 0, downloads: 0 });
});

test('more than one new job after the single export click fails closed', async (t) => {
  const spec = loadReportMd().specs.product_ratings_review_list; const root = temporaryRoot(t);
  const live = harness(root, spec, 'local', { ambiguous: true });
  await assert.rejects(() => local.run(live.input, live.dependencies), { code: 'review_export_new_job_ambiguous' });
  assert.equal(live.counts.clicks, 1); assert.equal(live.counts.downloads, 0);
});

test('both list response bindings require the provider MD origin path and method', () => {
  const spec = loadReportMd().specs.product_ratings_review_list;
  for (const [providerId, runner] of [['cross_border', cross], ['local', local]]) {
    const rules = spec.providers[providerId].official_validation;
    assert.equal(runner.listResponseMatches(response(rules.response_origin, rules.list_endpoint, rules.list_method, {}), rules), true);
    assert.equal(runner.listResponseMatches(response('https://wrong.example', rules.list_endpoint, rules.list_method, {}), rules), false);
    assert.equal(runner.listResponseMatches(response(rules.response_origin, '/wrong', rules.list_method, {}), rules), false);
    assert.equal(runner.listResponseMatches(response(rules.response_origin, rules.list_endpoint, 'GET', {}), rules), false);
  }
});
