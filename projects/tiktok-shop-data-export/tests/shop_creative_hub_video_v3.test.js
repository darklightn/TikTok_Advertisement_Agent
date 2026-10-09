'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { renderOutputPath } = require('../scripts/common/output-path');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');
const { writeWorkbook } = require('../scripts/common/xlsx_writer');
const { executeExport, preflightRunners, publishRunnerOutput } = require('../scripts/export');
const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');
const crossRunner = require('../scripts/routes/cross_border/shop_creative_hub_video');
const route = require('../scripts/routes/local/shop_creative_hub_video');
const runner = require('../scripts/routes/local/shop_creative_hub_video');

const START = '2026-08-01';
const END = '2026-08-17';
const SELLER_URL = 'https://seller-ph.tiktok.com/home';
const SIGNED_URL = 'https://download.example.test/creative.xlsx';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function realSpec() {
  const spec = loadReportMd().specs.shop_creative_hub_video;
  return { ...spec, official_validation: spec.providers.local.official_validation };
}

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function response(url, body, options = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return {
    status: () => options.status ?? 200,
    url: () => options.responseUrl || url,
    headers: () => options.headers || { 'content-type': 'application/json' },
    body: async () => buffer,
  };
}

function workbookBuffer(t, spec, rows) {
  const file = path.join(temporaryRoot(t), 'fixture.xlsx');
  writeWorkbook(file, [spec.headers, ...rows]);
  return fs.readFileSync(file);
}

function rowFor(spec, videoId = 'video-1') {
  const row = Array(spec.headers.length).fill('value');
  row[spec.headers.indexOf('Video ID')] = videoId;
  return row;
}

function taskQuery(...tasks) { return { code: 0, offline_tasks: tasks }; }

function inputFor(root, spec) {
  spec.providers.local.official_validation = spec.official_validation || spec.providers.local.official_validation;
  const outputDir = path.join(root, 'staging'); fs.mkdirSync(outputDir);
  return {
    a: { shop_alias: '测试店', browser_id: '7' },
    b: { seller_page_url: SELLER_URL },
    shop: { seller_id: '88001', provider_id: 'local' },
    reportSpec: spec, providerSpec: spec.providers.local, outputDir, startDate: START, endDate: END, route,
    advertiserId: '22001', advertiserName: '广告户', businessCenterId: '33001',
  };
}

function apiHarness(buffer, options = {}) {
  const calls = { probe: 0, create: 0, poll: 0, download: 0, fetch: [], delay: 0 };
  const filename = `Creatives video data ${START.replaceAll('-', '')} - ${END.replaceAll('-', '')}.xlsx`;
  const page = {
    url: () => SELLER_URL,
    request: {
      fetch: async (url, requestOptions) => {
        calls.fetch.push({ url, options: requestOptions });
        const pathname = new URL(url).pathname;
        if (pathname.endsWith('/post_video_list') && requestOptions.data.action === undefined) {
          calls.probe += 1;
          if (options.probeThrow) throw new Error('offline');
          return response(url, options.probeBody || { code: 0, data: { pagination: { total_count: options.total ?? 1 } } }, options.probeResponse);
        }
        if (pathname.endsWith('/post_video_list')) {
          calls.create += 1;
          if (options.createThrow) throw new Error('unknown');
          return response(url, options.createBody || { code: 0, extra: { task_id: '70001' } }, options.createResponse);
        }
        calls.poll += 1;
        const pollBody = options.pollBodies?.[calls.poll - 1]
          || (calls.poll === 1
            ? taskQuery({ download_id: '70001', task_status: 'PENDING' })
            : taskQuery({ download_id: '70001', task_status: 'SUCCESS', url: SIGNED_URL }));
        return response(url, pollBody, options.pollResponse);
      },
    },
  };
  const browserContext = {
    pages: () => [page],
    request: {
      get: async (url) => {
        calls.download += 1;
        if (options.downloadThrow) throw new Error('offline');
        return response(url, options.downloadBody || buffer, {
          status: options.downloadStatus ?? 200,
          responseUrl: options.downloadResponseUrl,
          headers: options.downloadHeaders || {
            'content-type': options.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="${options.filename || filename}"`,
          },
        });
      },
    },
  };
  return {
    calls, browserContext,
    dependencies: { browser: {}, browserContext, delay: async () => { calls.delay += 1; } },
  };
}

function publishContext(root) {
  return {
    request_id: 'creative-task-1', shop_id: '88001', seller_id: '88001', shop_name: '测试店',
    advertiser_id: '22001', advertiser_name: '广告户', business_center_id: '33001',
    provider_id: 'local', start_date: START, end_date: END, shop_root: path.join(root, '测试店__88001'),
  };
}

test('real MD exposes one shop-owned creative spec narrow aliases and strict specialized contract', () => {
  const loaded = loadReportMd(); const spec = realSpec();
  assert.equal(Object.keys(loaded.specs).length, 23);
  assert.equal(spec.owner_scope, 'shop'); assert.equal(spec.headers.length, 23);
  assert.deepEqual(spec.required_key_columns, ['Video ID', 'Product ID']); assert.doesNotThrow(() => runner.validateSpec(spec));
  assert.deepEqual(resolveReportIds('店铺素材中心视频', loaded), ['shop_creative_hub_video']);
  assert.deepEqual(resolveReportIds('scope:creative_hub_video', loaded), ['shop_creative_hub_video']);
  assert.throws(() => resolveReportIds('all', loaded), { code: 'report_alias_unknown' });
  assert.throws(() => resolveReportIds('default', loaded), { code: 'report_alias_unknown' });
});

test('selected provider validation rejects malformed dedicated rules', () => {
  const spec = realSpec();
  const provider = structuredClone(spec.providers.local);
  provider.official_validation.max_polls = 0;
  const selected = structuredClone(spec);
  selected.providers.local = provider;
  assert.throws(() => runner.validateSpec(selected, selected.providers.local), { code: 'creative_report_spec_invalid' });
  const extended = structuredClone(spec);
  extended.providers.local.official_validation.future_metadata = { ignored_by_runner: true };
  assert.doesNotThrow(() => runner.validateSpec(extended, extended.providers.local));
});

test('both provider runners bind MD response origin before HTTP or navigation', async (t) => {
  const loaded = loadReportMd();
  for (const [providerId, selectedRunner, expectedOrigin, wrongOrigin] of [
    ['cross_border', crossRunner, 'https://seller.tiktokshopglobalselling.com', 'https://seller-ph.tiktok.com'],
    ['local', runner, 'https://seller-ph.tiktok.com', 'https://seller.tiktokshopglobalselling.com'],
  ]) {
    const spec = structuredClone(loaded.specs.shop_creative_hub_video);
    spec.official_validation = spec.providers[providerId].official_validation;
    assert.equal(spec.official_validation.response_origin, expectedOrigin);
    function harness(pageOrigin) {
      const calls = { fetch: [], goto: 0 };
      const page = {
        url: () => `${pageOrigin}/home`,
        goto: async () => { calls.goto += 1; },
        request: { fetch: async (url) => { calls.fetch.push(url); return response(url, { code: 0, data: { pagination: { total_count: 0 } } }); } },
      };
      const browserContext = { pages: () => [page], request: { get: async () => { throw new Error('unexpected download'); } } };
      return { calls, dependencies: { browser: {}, browserContext } };
    }
    function selectedInput(sellerOrigin) {
      const root = temporaryRoot(t); const outputDir = path.join(root, 'staging'); fs.mkdirSync(outputDir);
      return {
        a: {}, b: { seller_page_url: `${sellerOrigin}/home` },
        shop: { seller_id: '88001', provider_id: providerId }, reportSpec: spec,
        providerSpec: spec.providers[providerId], outputDir, startDate: START, endDate: END,
        advertiserId: '22001', businessCenterId: '33001',
      };
    }
    const matching = harness(expectedOrigin);
    const result = await selectedRunner.run(selectedInput(expectedOrigin), matching.dependencies);
    assert.equal(result.status, 'no_data');
    assert.equal(matching.calls.fetch.length, 1);
    assert.equal(new URL(matching.calls.fetch[0]).origin, expectedOrigin);
    assert.equal(matching.calls.goto, 0);

    const wrongSeller = harness(expectedOrigin);
    await assert.rejects(() => selectedRunner.run(selectedInput(wrongOrigin), wrongSeller.dependencies), { code: 'provider_binding_invalid' });
    assert.deepEqual(wrongSeller.calls, { fetch: [], goto: 0 });

    const wrongPage = harness(wrongOrigin);
    await assert.rejects(() => selectedRunner.run(selectedInput(expectedOrigin), wrongPage.dependencies), { code: 'seller_page_missing' });
    assert.deepEqual(wrongPage.calls, { fetch: [], goto: 0 });
  }
});

test('official success creates once polls the exact task downloads once and publishes unchanged bytes', async (t) => {
  const root = temporaryRoot(t); const spec = realSpec();
  const official = workbookBuffer(t, spec, [rowFor(spec)]); const api = apiHarness(official, { filename:'unexpected-name.bin' });
  const input = inputFor(root, spec); const result = await runner.run(input, api.dependencies);
  assert.equal(result.status, 'success'); assert.equal(result.data_row_count, 1);
  assert.deepEqual([api.calls.probe, api.calls.create, api.calls.poll, api.calls.download], [1, 1, 2, 1]);
  assert.equal(api.calls.fetch.every((call) => {
    const url = new URL(call.url);
    return url.searchParams.get('oec_seller_id') === '88001'
      && url.searchParams.get('aadvid') === '22001' && url.searchParams.get('bc_id') === '33001';
  }), true);
  assert.deepEqual(fs.readFileSync(result.output_file), official); assert.equal(result.sha256, sha256(official));

  const context = publishContext(root); const destination = renderOutputPath(spec, context.shop_root, {
    start_date: START, end_date: END, time_file: `${START}_至_${END}.xlsx`, shop_name: '测试店', shop_id: '88001',
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old');
  const published = publishRunnerOutput(result, spec, context, input.outputDir);
  assert.equal(published.status, 'success'); assert.equal(published.files[0], destination);
  assert.deepEqual(fs.readFileSync(destination), official); assert.equal(published.sha256, sha256(official));
});

test('official total zero creates no task and publishes a trusted header-only replacement', async (t) => {
  const root = temporaryRoot(t); const spec = realSpec();
  const api = apiHarness(Buffer.alloc(0), { total: 0 }); const input = inputFor(root, spec);
  const result = await runner.run(input, api.dependencies);
  assert.equal(result.status, 'no_data'); assert.equal(result.row_count, 0);
  assert.deepEqual([api.calls.probe, api.calls.create, api.calls.poll, api.calls.download], [1, 0, 0, 0]);
  assert.deepEqual(readFirstWorksheet(fs.readFileSync(result.output_file)).headers, spec.headers);
  const context = publishContext(root); const destination = renderOutputPath(spec, context.shop_root, {
    start_date: START, end_date: END, time_file: `${START}_至_${END}.xlsx`, shop_name: '测试店', shop_id: '88001',
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old-non-empty');
  const published = publishRunnerOutput(result, spec, context, input.outputDir);
  assert.equal(published.status, 'no_data'); assert.equal(published.data_row_count, 0);
  assert.deepEqual(readFirstWorksheet(fs.readFileSync(destination)).headers, spec.headers);
});

test('task binding create uncertainty polling and signed download errors fail closed without overwriting old bytes', async (t) => {
  const spec = realSpec();
  const cases = [
    { options: { createThrow: true }, code: 'official_task_create_result_unknown' },
    { options: { pollBodies: [taskQuery({ download_id: '70001', download_scene: 'wrong', task_status: 'SUCCESS', url: SIGNED_URL })] }, code: 'official_task_binding_mismatch' },
    {
      options: { pollBodies: [
        taskQuery({ download_id: 'other', download_scene: 'creative_hub_video_export', task_status: 'SUCCESS', url: SIGNED_URL }),
        taskQuery({ download_id: 'other', download_scene: 'creative_hub_video_export', task_status: 'SUCCESS', url: SIGNED_URL }),
      ] },
      mutateSpec: (value) => { value.official_validation.max_polls = 2; },
      code: 'official_task_timeout',
    },
    { options: { pollBodies: [taskQuery({ download_id: '70001', download_scene: 'creative_hub_video_export', task_status: 'FAILED' })] }, code: 'official_task_failed' },
    { options: { downloadStatus: 401 }, code: 'transport_login_required' },
    { options: { contentType: 'text/html', downloadBody: Buffer.from('<html>login</html>') }, code: 'transport_login_required' },
    { options: { downloadBody: Buffer.from('not-a-zip') }, code: 'official_workbook_invalid' },
  ];
  for (const item of cases) {
    const root = temporaryRoot(t); const caseSpec = structuredClone(spec); item.mutateSpec?.(caseSpec);
    const good = workbookBuffer(t, caseSpec, [rowFor(caseSpec)]);
    const api = apiHarness(good, item.options); const input = inputFor(root, caseSpec);
    const sentinel = path.join(root, 'formal.xlsx'); fs.writeFileSync(sentinel, 'old');
    await assert.rejects(() => runner.run(input, api.dependencies), { code: item.code });
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'old'); assert.equal(api.calls.create <= 1, true);
    assert.equal(api.calls.download <= 1, true);
  }
});

test('creative hub timeout preserves sanitized task polling evidence', async (t) => {
  const spec = realSpec(); spec.official_validation.max_polls = 2;
  const root = temporaryRoot(t); const good = workbookBuffer(t, spec, [rowFor(spec)]);
  const api = apiHarness(good, { pollBodies:[taskQuery({ download_id:'other', download_scene:'creative_hub_video_export', task_status:'SUCCESS', url:SIGNED_URL }), taskQuery({ download_id:'other', download_scene:'creative_hub_video_export', task_status:'SUCCESS', url:SIGNED_URL })] });
  await assert.rejects(() => runner.run(inputFor(root, spec), api.dependencies), (error) => {
    assert.equal(error.code, 'official_task_timeout'); assert.equal(error.diagnostics.task_id, '70001');
    assert.equal(error.diagnostics.attempts, 2); assert.equal(error.diagnostics.task_observed, false);
    assert.equal(error.diagnostics.outcome, 'task_not_observed'); assert.equal(error.diagnostics.url_present, false);
    return true;
  });
});

test('executeExport preserves the real formal creative file and leaves no sibling temp when runner validation fails', async (t) => {
  const root = temporaryRoot(t); const loaded = loadReportMd(); const spec = realSpec();
  const api = apiHarness(Buffer.from('not-a-zip'), {
    pollBodies: [taskQuery({ download_id: '70001', download_scene: 'creative_hub_video_export', task_status: 'SUCCESS', url: SIGNED_URL })],
  });
  const shopRoot = path.join(root, '测试店__88001');
  const destination = renderOutputPath(spec, shopRoot, {
    start_date: START, end_date: END, time_file: `${START}_至_${END}.xlsx`, shop_name: '测试店', shop_id: '88001',
  });
  const sentinel = Buffer.from('formal-old-creative-bytes');
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, sentinel);
  const browser = { isConnected: () => true, contexts: () => [api.browserContext] };
  let closes = 0; let stagingDir;
  const result = await executeExport({
    shop: '测试店', advertiser: '22001', report_scopes: ['scope:creative_hub_video'],
    start_date: START, end_date: END,
  }, {
    loadReportMd: () => loaded,
    createRunSession: async () => ({
      browser, browserContext: api.browserContext,
      runContext: {
        request_id: 'creative-failure-1', shop_id: '88001', seller_id: '88001', shop_name: '测试店',
        browser_id: '7', advertiser_id: '22001', advertiser_name: '广告户', business_center_id: '33001',
        provider_id: 'local', shop_type: 'local', shop_code: 'SHOP001', seller_type: 2, business_type: 1,
        shop_region: 'PH', region_code: 'PH', seller_hostname: 'seller-ph.tiktok.com',
        shop_root: shopRoot, start_date: START, end_date: END,
        report_ids: ['shop_creative_hub_video'],
        a: { shop_alias: '测试店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222' },
        b: { requested_shop_alias: '测试店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222', seller_page_url: SELLER_URL },
        shop: { shop_alias: '测试店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222', provider_id: 'local', seller_id: '88001', shop_type: 'local', shop_code: 'SHOP001', seller_type: 2, business_type: 1, shop_region: 'PH', region_code: 'PH', seller_hostname: 'seller-ph.tiktok.com' },
      },
      close: async () => { closes += 1; },
    }),
    makeStagingDir: () => { stagingDir = fs.mkdtempSync(path.join(root, 'stage-')); return stagingDir; },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reports[0].reason_code, 'official_workbook_invalid');
  assert.deepEqual(fs.readFileSync(destination), sentinel);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), [path.basename(destination)]);
  assert.equal(fs.existsSync(stagingDir), false); assert.equal(closes, 1);
});

test('workbook accepts changed headers and keys but rejects zero data rows', async (t) => {
  const spec = realSpec();
  const wrongHeader = structuredClone(spec.headers); wrongHeader[1] = 'Wrong';
  const fixtures = [
    { rows: [rowFor(spec)], headers: wrongHeader, total: 1, count: 1 },
    { rows: [rowFor(spec, 'dup'), rowFor(spec, 'dup')], total: 99, count: 2 },
    { rows: [rowFor(spec, '')], total: 1, count: 1 },
  ];
  for (const fixture of fixtures) {
    const root = temporaryRoot(t); const file = path.join(root, 'source.xlsx');
    writeWorkbook(file, [fixture.headers || spec.headers, ...fixture.rows]);
    const api = apiHarness(fs.readFileSync(file), { total: fixture.total }); const input = inputFor(root, spec);
    const result = await runner.run(input, api.dependencies);
    assert.equal(result.status, 'success'); assert.equal(result.data_row_count, fixture.count);
  }
  const root = temporaryRoot(t); const file = path.join(root, 'zero.xlsx'); writeWorkbook(file, [spec.headers]);
  const api = apiHarness(fs.readFileSync(file), { total: 1 });
  await assert.rejects(() => runner.run(inputFor(root, spec), api.dependencies), { code:'official_data_row_count_mismatch' });
});

test('frozen input identity and provider failures occur before any HTTP call', async (t) => {
  const spec = realSpec();
  for (const mutate of [
    (input) => { input.advertiserId = null; },
    (input) => { input.businessCenterId = 'bad'; },
    (input) => { input.shop.seller_id = ''; },
    (input) => { input.shop.provider_id = 'cross_border'; },
  ]) {
    const root = temporaryRoot(t); const api = apiHarness(Buffer.alloc(0), { total: 0 }); const input = inputFor(root, spec);
    mutate(input); await assert.rejects(() => runner.run(input, api.dependencies)); assert.equal(api.calls.fetch.length, 0);
  }
});
