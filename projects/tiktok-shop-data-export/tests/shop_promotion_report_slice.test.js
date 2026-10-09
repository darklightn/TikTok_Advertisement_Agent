'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveDateRange } = require('../scripts/common/date_range');

const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');
const { renderOutputPath } = require('../scripts/common/output-path');
const { publishOfficialDownload } = require('../scripts/common/output-publish');
const { readZipEntries } = require('../scripts/common/xlsx_first_sheet');
const { writeWorkbook, zip } = require('../scripts/common/xlsx_writer');
const { exportPromotionPerformance, selectLatestSellerPage } = require('../scripts/routes/local/shop_promotion_performance');
const {
  exportPromotionPerformance: exportCrossPromotionPerformance,
} = require('../scripts/routes/cross_border/shop_promotion_performance');
const route = require('../scripts/routes/local/shop_promotion_performance');
const { inspectOfficialDownload, validate, validateOfficialValidation } = require('../scripts/validation/validate_shop_promotion_performance');

const START = '2026-08-01';
const END = '2026-08-17';
const OFFICIAL_FILENAME = 'Shop Promotion List - 20260820010101.xlsx';
const PROMOTION_HEADERS = ['任意表头A', '任意表头B'];

function temporaryRoot(t, prefix = 'promotion-slice-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function realContract() {
  const loaded = loadReportMd();
  const spec = loaded.specs.shop_promotion_performance;
  return { loaded, spec: { ...spec, official_validation: spec.providers.local.official_validation } };
}

function fixture(file, spec, rows = [['1001', '活动一']], headers = PROMOTION_HEADERS) {
  writeWorkbook(file, [
    [`[日期范围] ${START} - 2026-08-18`],
    headers,
    ...rows,
  ]);
  return fs.readFileSync(file);
}

function addSecondSheet(file) {
  const entries = readZipEntries(fs.readFileSync(file));
  entries.set('xl/workbook.xml', entries.get('xl/workbook.xml').toString('utf8').replace('</sheets>', '<sheet name="额外" sheetId="2" r:id="rId3"/></sheets>'));
  entries.set('xl/_rels/workbook.xml.rels', entries.get('xl/_rels/workbook.xml.rels').toString('utf8').replace('</Relationships>', '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
  entries.set('[Content_Types].xml', entries.get('[Content_Types].xml').toString('utf8').replace('</Types>', '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
  entries.set('xl/worksheets/sheet2.xml', entries.get('xl/worksheets/sheet1.xml'));
  fs.writeFileSync(file, zip([...entries]));
}

function input(root, spec) {
  const identity = { browser_id: '7', cdp_url: 'http://127.0.0.1:9222' };
  return {
    a: { ...identity, status: 'ready', shop_alias: '测试店' },
    b: { ...identity, status: 'operable', requested_shop_alias: '测试店', seller_page_url: 'https://seller-ph.tiktok.com/home' },
    shop: { ...identity, status: 'identified', shop_alias: '测试店', provider_id: 'local', seller_id: '88' },
    route, reportSpec: spec, providerSpec: spec.providers.local, startDate: START, endDate: END,
    outputDir: path.join(root, 'runner-output'), timeoutMs: 25,
  };
}

function runnerHarness(root, spec, options = {}) {
  const source = path.join(root, 'browser-download.xlsx');
  if (options.bytes) fs.writeFileSync(source, options.bytes); else fixture(source, spec, options.rows);
  const counts = { connects: 0, clicks: 0, closes: 0, enabledChecks: 0, gotos: [], locators: [], downloadTimeouts: [], scrolls: 0, dateRules: [], events: [] };
  let currentUrl = 'https://seller-ph.tiktok.com/home';
  let resolveDownload;
  let rejectDownload;
  const downloadPromise = new Promise((resolve, reject) => { resolveDownload = resolve; rejectDownload = reject; });
  const control = {
    async waitFor() {}, async count() { return 1; }, async isVisible() { return true; }, async isEnabled() {
      const states = options.enabledStates || [true];
      const state = states[Math.min(counts.enabledChecks, states.length - 1)];
      counts.enabledChecks += 1;
      return state;
    },
    async click() {
      counts.clicks += 1;
      if (options.downloadFailure) rejectDownload(Object.assign(new Error('download timeout'), { code: 'download_timeout' }));
      else resolveDownload({ suggestedFilename: () => options.filename || OFFICIAL_FILENAME, path: async () => source });
    },
    async scrollIntoViewIfNeeded() { counts.scrolls += 1; },
  };
  const page = {
    url: () => currentUrl,
    async goto(url) { counts.events.push('goto'); currentUrl = url; counts.gotos.push(url); },
    locator: (selector) => { counts.locators.push(selector); return control; },
    waitForEvent: (_event, options) => { counts.downloadTimeouts.push(options.timeout); return downloadPromise; },
  };
  const browserContext = { pages: () => [page] };
  const browser = { isConnected: () => true, contexts: () => [browserContext], close: async () => { counts.closes += 1; } };
  return {
    counts,
    dependencies: {
      browser,
      browserContext,
      applyDateRange: async (_page, _start, _end, rules) => {
        counts.dateRules.push(rules);
        if (options.dateFailure) fail(options.dateFailure);
      },
      currencyText: '₱',
      now: new Date('2026-08-20T00:00:00Z'),
    },
  };
}

function fail(code) { throw Object.assign(new Error(code), { code }); }

function publisherOptions(result, spec, root, overrides = {}) {
  return {
    spec, sourceFile: result.output_file, expectedSha256: result.sha256,
    status: result.status, dataRowCount: result.data_row_count,
    noDataEvidence: result.no_data_evidence,
    shopRoot: path.join(root, 'shop'), taskId: 'task-001',
    variables: { start_date: START, end_date: END, time_file: `${START}_至_${END}.xlsx` },
    ...overrides,
  };
}

test('real MD routes only the dedicated promotion aliases and scope', () => {
  const { loaded, spec } = realContract();
  assert.equal(spec.report_id, 'shop_promotion_performance');
  for (const alias of ['report:shop_promotion_performance', 'shop_promotion_performance', '营销活动表现', 'category:promotion_diagnostics']) {
    assert.deepEqual(resolveReportIds(alias, loaded), ['shop_promotion_performance']);
  }
  for (const alias of ['all', 'default']) assert.throws(() => resolveReportIds(alias, loaded), { code: 'report_alias_unknown' });
  assert.equal(Object.hasOwn(spec, 'headers'), false);
  assert.equal(Object.hasOwn(spec, 'required_key_columns'), false);
  assert.equal(spec.no_data_output_type, null);
  assert.equal(spec.official_validation.data_start_row, 3);
  assert.equal(Object.hasOwn(spec.official_validation, 'headers'), false);
});

test('runner preserves and publishes nonempty official bytes to the stable range path', async (t) => {
  const root = temporaryRoot(t); const { spec } = realContract(); const harness = runnerHarness(root, spec);
  const result = await exportPromotionPerformance(input(root, spec), harness.dependencies);
  assert.equal(result.status, 'success'); assert.equal(result.data_row_count, 1); assert.equal(harness.counts.clicks, 1); assert.equal(harness.counts.closes, 0);
  assert.deepEqual(harness.counts.events, ['goto']);
  assert.equal(harness.counts.scrolls, 1);
  assert.equal(validate(result, spec).status, 'passed');
  const sourceBytes = fs.readFileSync(result.output_file); assert.equal(result.sha256, crypto.createHash('sha256').update(sourceBytes).digest('hex'));
  const destination = renderOutputPath(spec, path.join(root, 'shop'), { time_file: `${START}_至_${END}.xlsx` });
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old');
  const published = publishOfficialDownload(publisherOptions(result, spec, root));
  assert.equal(published.status, 'success'); assert.equal(published.output_file, destination); assert.equal(published.sha256, result.sha256);
  assert.equal(fs.readFileSync(destination).equals(sourceBytes), true);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), [path.basename(destination)]);
});

test('downloaded workbook with zero data rows fails and preserves old formal bytes', async (t) => {
  const root = temporaryRoot(t, 'promotion-zero-'); const { spec } = realContract(); const harness = runnerHarness(root, spec, { rows: [] });
  const destination = renderOutputPath(spec, path.join(root, 'shop'), { time_file: `${START}_至_${END}.xlsx` });
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old-nonempty');
  await assert.rejects(() => exportPromotionPerformance(input(root, spec), harness.dependencies), { code:'official_data_row_count_mismatch' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old-nonempty');
});

test('malformed contract and missing frozen seller identity fail before browser connect', async (t) => {
  const root = temporaryRoot(t, 'promotion-preconnect-'); const { spec } = realContract();
  async function rejectsBeforeConnect(reportSpec, code) {
    const selected = structuredClone(reportSpec);
    selected.providers.local.official_validation = selected.official_validation;
    const harness = runnerHarness(root, spec);
    await assert.rejects(() => exportPromotionPerformance(input(root, selected), harness.dependencies), { code });
    assert.equal(harness.counts.connects, 0); assert.equal(harness.counts.clicks, 0); assert.equal(harness.counts.closes, 0);
  }
  await rejectsBeforeConnect({ ...spec, official_validation: { ...spec.official_validation, data_start_row: undefined } }, 'promotion_official_validation_invalid');
  await rejectsBeforeConnect({ ...spec, official_validation: { ...spec.official_validation, data_start_row: 0 } }, 'promotion_official_validation_invalid');
  assert.doesNotThrow(() => validateOfficialValidation({
    ...spec,
    official_validation: { ...spec.official_validation, future_metadata: { ignored_by_validator: true } },
  }));
  const missingIdentity = input(root, spec); delete missingIdentity.shop.seller_id; const identityHarness = runnerHarness(root, spec);
  await assert.rejects(() => exportPromotionPerformance(missingIdentity, identityHarness.dependencies), { code: 'promotion_identity_unavailable' }); assert.equal(identityHarness.counts.connects, 0); assert.equal(identityHarness.counts.clicks, 0); assert.equal(identityHarness.counts.closes, 0);
});

test('both promotion runners reject seller and provider MD origin mismatch before navigation or download', async (t) => {
  const base = loadReportMd().specs.shop_promotion_performance;
  for (const [providerId, selectedRunner, wrongOrigin] of [
    ['cross_border', exportCrossPromotionPerformance, 'https://seller-ph.tiktok.com'],
    ['local', exportPromotionPerformance, 'https://seller.tiktokshopglobalselling.com'],
  ]) {
    const root = temporaryRoot(t, `promotion-${providerId}-origin-`);
    const spec = structuredClone(base);
    spec.official_validation = spec.providers[providerId].official_validation;
    const harness = runnerHarness(root, spec);
    const selected = input(root, spec);
    selected.b.seller_page_url = `${wrongOrigin}/home`;
    selected.shop.provider_id = providerId;
    selected.providerSpec = spec.providers[providerId];
    await assert.rejects(() => selectedRunner(selected, harness.dependencies), { code: 'provider_binding_invalid' });
    assert.deepEqual(harness.counts.gotos, []);
    assert.equal(harness.counts.clicks, 0);
    assert.deepEqual(harness.counts.downloadTimeouts, []);
  }
});

test('official validator ignores basename sheet header and date changes but rejects unreadable or zero-row XLSX', (t) => {
  const root = temporaryRoot(t, 'promotion-validation-'); const { spec } = realContract(); const valid = path.join(root, 'valid.xlsx'); fixture(valid, spec);
  const formal = renderOutputPath(spec, path.join(root, 'shop'), { time_file: `${START}_至_${END}.xlsx` }); fs.mkdirSync(path.dirname(formal), { recursive: true }); fs.writeFileSync(formal, 'old-formal-bytes');
  const inspect = (sourceFile) => inspectOfficialDownload({ sourceFile, reportSpec: spec });
  assert.equal(inspect(valid).status, 'success');
  const wrongHeader = path.join(root, 'header.xlsx'); writeWorkbook(wrongHeader, [['other banner'], ['wrong'], ['data']]); assert.equal(inspect(wrongHeader).status, 'success');
  const wrongDate = path.join(root, 'date.xlsx'); writeWorkbook(wrongDate, [['unrelated'], ['changed'], ['data']]); assert.equal(inspect(wrongDate).status, 'success');
  const multiple = path.join(root, 'multiple.xlsx'); fixture(multiple, spec); addSecondSheet(multiple); assert.equal(inspect(multiple).status, 'success');
  const zero = path.join(root, 'zero.xlsx'); writeWorkbook(zero, [['banner'], ['header']]); assert.equal(inspect(zero).reason_code, 'official_data_row_count_mismatch');
  const invalidZip = path.join(root, 'invalid.xlsx'); fs.writeFileSync(invalidZip, 'not-xlsx'); assert.equal(inspect(invalidZip).status, 'failed');
  assert.throws(() => validateOfficialValidation({ ...spec, official_validation: { ...spec.official_validation, data_start_row: null } }), { code: 'promotion_official_validation_invalid' });
  assert.equal(fs.readFileSync(formal, 'utf8'), 'old-formal-bytes');
});

test('publisher rejects hash status and replace failures without touching the old formal file', async (t) => {
  const root = temporaryRoot(t, 'promotion-publish-fail-'); const { spec } = realContract(); const harness = runnerHarness(root, spec);
  const result = await exportPromotionPerformance(input(root, spec), harness.dependencies);
  const destination = renderOutputPath(spec, path.join(root, 'shop'), { time_file: `${START}_至_${END}.xlsx` });
  fs.mkdirSync(path.dirname(destination), { recursive: true }); const old = Buffer.from('old-formal-bytes');
  const reject = (overrides, reason) => {
    fs.writeFileSync(destination, old); const published = publishOfficialDownload(publisherOptions(result, spec, root, overrides));
    assert.equal(published.reason_code, reason); assert.equal(fs.readFileSync(destination).equals(old), true);
    assert.deepEqual(fs.readdirSync(path.dirname(destination)), [path.basename(destination)]);
  };
  reject({ expectedSha256: '0'.repeat(64) }, 'source_hash_mismatch');
  const wrongExtension = path.join(root, 'source.bin'); fs.copyFileSync(result.output_file, wrongExtension);
  reject({ sourceFile: wrongExtension }, 'unsupported_output_type');
  reject({ status: 'success', dataRowCount: 0 }, 'status_row_count_mismatch');
  reject({ variables: { start_date: START, end_date: END, time_file: 'wrong.xlsx' } }, 'output_time_file_invalid');
  reject({ replaceFile: () => { throw new Error('injected'); } }, 'output_replace_failed');
});

test('download failure and invalid downloaded workbook never click more than once', async (t) => {
  const { spec } = realContract();
  const missingRoot = temporaryRoot(t, 'promotion-download-missing-'); const missing = runnerHarness(missingRoot, spec, { downloadFailure: true });
  await assert.rejects(() => exportPromotionPerformance(input(missingRoot, spec), missing.dependencies), { code: 'download_timeout' }); assert.equal(missing.counts.clicks, 1);
  const invalidRoot = temporaryRoot(t, 'promotion-download-invalid-'); const invalid = runnerHarness(invalidRoot, spec, { bytes: Buffer.from('not-xlsx') });
  await assert.rejects(() => exportPromotionPerformance(input(invalidRoot, spec), invalid.dependencies)); assert.equal(invalid.counts.clicks, 1);
});

test('promotion waits for a transiently disabled export button before clicking once', async (t) => {
  const root = temporaryRoot(t, 'promotion-button-ready-'); const { spec } = realContract();
  const harness = runnerHarness(root, spec, { enabledStates: [false, true] });
  const result = await exportPromotionPerformance(input(root, spec), harness.dependencies);
  assert.equal(result.status, 'success');
  assert.equal(harness.counts.enabledChecks >= 2, true);
  assert.equal(harness.counts.clicks, 1);
});

test('local promotion waits for the visible picker to become interactive before clicking', async () => {
  const { spec } = realContract(); const rules = spec.official_validation;
  let now = 0; let pickerChecks = 0; let pickerClicks = 0; let delays = 0;
  const inputLocator = { count:async () => 2, nth:(index) => ({ isEnabled:async () => pickerChecks > 1, inputValue:async () => index === 0 ? START : END }) };
  const cell = { count:async () => 1, click:async () => {} };
  const panel = { locator:(selector) => selector === rules.header_label_selector
    ? { allInnerTexts:async () => ['2026','8'] }
    : selector === rules.date_cell_selector ? { filter:() => cell } : { first:() => ({ click:async () => {} }), last:() => ({ click:async () => {} }) } };
  const panels = { first:() => ({ ...panel, waitFor:async () => {} }), last:() => panel, count:async () => 2 };
  const picker = {
    first:() => picker, waitFor:async () => {},
    getAttribute:async () => { pickerChecks += 1; return pickerChecks === 1 ? `x ${rules.date_picker_disabled_class}` : 'x'; },
    locator:() => inputLocator, click:async () => { pickerClicks += 1; assert.equal(delays, 1); },
  };
  const page = { locator:(selector) => selector === rules.date_picker_selector ? picker : panels };
  await route.applyDateRange(page, START, END, rules, { nowMs:() => now, delay:async (ms) => { delays += 1; now += ms; } });
  assert.equal(pickerClicks, 1);
});

test('local promotion does not click a picker that remains disabled', async () => {
  const { spec } = realContract(); const rules = { ...spec.official_validation, picker_timeout_ms:100 };
  let now = 0; let clicks = 0;
  const picker = { first:() => picker, waitFor:async () => {}, getAttribute:async () => rules.date_picker_disabled_class,
    locator:() => ({ count:async () => 2, nth:() => ({ isEnabled:async () => false }) }), click:async () => { clicks += 1; } };
  const page = { locator:() => picker };
  await assert.rejects(() => route.applyDateRange(page, START, END, rules,
    { nowMs:() => now, delay:async (ms) => { now += ms; } }), { code:'promotion_date_picker_not_ready' });
  assert.equal(clicks, 0);
});

test('promotion date preflight accepts the Manila business day and rejects only the future', () => {
  const now = new Date('2026-08-30T16:30:00.000Z');
  const current = resolveDateRange({ startDate:'2026-08-31', endDate:'2026-08-31' }, now, 'Asia/Manila');
  assert.equal(current.business_today, '2026-08-31'); assert.equal(current.start_date, '2026-08-31');
  assert.throws(() => resolveDateRange({ startDate:'2026-09-01', endDate:'2026-09-01' }, now, 'Asia/Manila'), { code:'invalid_date' });
  assert.throws(() => resolveDateRange({ startDate:'2026-02-30', endDate:'2026-02-30' }, now, 'Asia/Manila'), { code:'invalid_date' });
});

test('promotion reports current_date_not_exportable only for an explicitly disabled current-day cell', async () => {
  const { spec } = realContract(); const rules = spec.official_validation; const today = END;
  const cell = (count) => ({ count:async () => count, click:async () => {} });
  const panel = { locator:(selector) => selector === rules.header_label_selector ? { allInnerTexts:async () => ['2026','8'] }
    : selector === rules.date_cell_selector ? { filter:({hasText}) => cell(hasText.test(String(Number(START.slice(8,10)))) ? 1 : 0) }
      : selector === rules.date_cell_disabled_selector ? { filter:({hasText}) => cell(hasText.test(String(Number(today.slice(8,10)))) ? 1 : 0) }
        : { first:() => ({ click:async () => {} }), last:() => ({ click:async () => {} }) } };
  const panels = { first:() => ({ ...panel, waitFor:async () => {} }), last:() => panel, count:async () => 2 };
  const picker = { first:() => picker, waitFor:async () => {}, getAttribute:async () => '', locator:() => ({ count:async () => 2, nth:() => ({ isEnabled:async () => true }) }), click:async () => {} };
  const page = { locator:(selector) => selector === rules.date_picker_selector ? picker : panels };
  await assert.rejects(() => route.applyDateRange(page, START, today, rules, {}, today), { code:'current_date_not_exportable' });
});

test('promotion does not click when local picker date selection fails', async (t) => {
  const root = temporaryRoot(t, 'promotion-date-selection-'); const { spec } = realContract();
  const harness = runnerHarness(root, spec, { dateFailure: 'promotion_date_not_applied' });
  await assert.rejects(() => exportPromotionPerformance(input(root, spec), harness.dependencies), { code: 'promotion_date_not_applied' });
  assert.equal(harness.counts.clicks, 0);
});

test('promotion fails without clicking when the export button stays disabled', async (t) => {
  const root = temporaryRoot(t, 'promotion-button-disabled-'); const { spec } = realContract();
  const sentinel = structuredClone(spec); sentinel.official_validation.download_timeout_ms = 10;
  const harness = runnerHarness(root, sentinel, { enabledStates: [false] });
  await assert.rejects(() => exportPromotionPerformance(input(root, sentinel), harness.dependencies), { code: 'shop_promotion_performance_export_control_not_ready' });
  assert.equal(harness.counts.clicks, 0);
});

test('promotion execution entry selector and timeouts are driven by report MD rules', async (t) => {
  const root = temporaryRoot(t, 'promotion-sentinel-'); const { spec } = realContract();
  const sentinel = structuredClone(spec);
  Object.assign(sentinel.official_validation, {
    entry_path: '/sentinel-promotion', export_selector: '[data-sentinel="export"]',
    navigation_timeout_ms: 4321, download_timeout_ms: 5432,
  });
  sentinel.official_validation.entry_query = { range: 'sentinel_range', shortcut: 'sentinel_shortcut', shortcut_value: 'sentinel_value', end_semantics: 'exclusive_next_day' };
  const harness = runnerHarness(root, sentinel);
  await exportPromotionPerformance(input(root, sentinel), harness.dependencies);
  const entered = new URL(harness.counts.gotos[0]);
  assert.equal(entered.pathname, '/sentinel-promotion');
  assert.equal(harness.counts.locators.includes('[data-sentinel="export"]'), true);
  assert.equal(harness.counts.dateRules[0], sentinel.official_validation);
  assert.deepEqual(harness.counts.downloadTimeouts, [5432]);
});

test('promotion selects the latest Seller page when multiple local tabs exist', () => {
  const first = { url: () => 'https://seller-ph.tiktok.com/compass/promotion-analytics?old=1' };
  const latest = { url: () => 'https://seller-ph.tiktok.com/compass/promotion-analytics?current=1' };
  assert.equal(selectLatestSellerPage({ pages: () => [first, latest] }, 'https://seller-ph.tiktok.com'), latest);
});

test('promotion runner consumes only provider execution rules and not content headers', () => {
  const runner = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'routes', 'local', 'shop_promotion_performance.js'), 'utf8');
  assert.equal(runner.includes('EXPECTED_HEADERS'), false);
  assert.equal(runner.includes('official_filename'), false);
  assert.match(runner, /input\.providerSpec\.official_validation/u);
});
