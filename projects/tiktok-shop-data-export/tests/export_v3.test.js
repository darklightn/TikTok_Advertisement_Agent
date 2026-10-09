'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { sha256File } = require('../scripts/common/file-check');
const { validateReportSpec } = require('../scripts/common/md-spec-validator');
const { renderOutputPath } = require('../scripts/common/output-path');
const { parseRunRequest } = require('../scripts/common/run-context');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');
const { writeWorkbook } = require('../scripts/common/xlsx_writer');
const {
  executeExport, inspectRunnerOutput, loadProviderRunner, main, outputVariables,
  publishRunnerOutput, selectProvider,
} = require('../scripts/export');
const { loadReportMd } = require('../scripts/load-report-md');

const SELLER_URL = 'https://seller-ph.tiktok.com/home';
const DISABLED_REPORT_IDS = [];

test('real recommendation failures isolate report scope, retain old files and sanitize details; account drift aborts', async t => {
  const real = require('../scripts/routes/local/gmvmax_campaign_recommendation_snapshot');
  for (const kind of ['structure', 'plan', 'query', 'seller', 'advertiser']) {
    let laterCalls = 0;
    const h = harness(t, {
      gmvmax_campaign_recommendation_snapshot: async (input, dependencies) => {
        const page = dependencies.browserContext.pages()[0];
        page.request = { fetch: async (url) => {
          const final = new URL(url); const id = final.searchParams.get('campaign_id');
          let body;
          if (!id) body = { code: 0, data: { table: ['100', '200'].map(campaign_id => ({ campaign_id, campaign_name: 'Campaign ' + campaign_id })), pagination: { total_count: 2, page_count: 1, page: 1 } } };
          else {
            let item = { entity_type: 2, apply_entity: { type: 2, id }, content: { meta: { campaign_id: id } } };
            if (id === '200') {
              if (kind === 'structure') item = null;
              if (kind === 'plan') item.content.meta.campaign_id = '999';
              if (kind === 'query') final.searchParams.delete('placements');
              if (kind === 'seller') final.searchParams.set('oec_seller_id', '999');
              if (kind === 'advertiser') final.searchParams.set('aadvid', '999');
            }
            body = { code: 0, data: { items: [item], summary: {} } };
          }
          return { url: () => final.href, status: () => 200, body: async () => Buffer.from(JSON.stringify(body)) };
        } };
        return real.run(input, dependencies);
      },
      inventory_snapshot: async (...args) => { laterCalls += 1; return generatedRunner('success')(...args); },
    }, { advertiserId: '22001', advertiserName: 'Account', advertiserCurrency: 'PHP', businessCenterId: '33001' });
    const formal = path.join(h.state.shopRoot, '计划数据', 'GMV Max 建议快照', 'Campaign 100__items__2026-09-01.xlsx');
    fs.mkdirSync(path.dirname(formal), { recursive: true });
    writeWorkbook(formal, [['campaign_id', 'items_json', 'currency'], ['100', '["existing"]', 'PHP']]);
    const original = sha256File(formal);
    const result = await executeExport({ shop: '测试店', report_scopes: ['gmvmax_campaign_recommendation_snapshot', 'inventory_snapshot'] }, h.dependencies);
    const fatal = kind === 'seller' || kind === 'advertiser';
    const expected = { structure: 'campaign_recommendation_shape_invalid', plan: 'campaign_recommendation_plan_conflict', query: 'campaign_recommendation_request_scope_invalid', seller: 'provider_binding_invalid', advertiser: 'provider_binding_invalid' };
    assert.equal(result.reports[0].reason_code, expected[kind]);
    assert.equal(result.status, fatal ? 'failed' : 'partial');
    assert.equal(laterCalls, fatal ? 0 : 1);
    assert.equal(result.reports[1].status, fatal ? 'failed' : 'success');
    if (fatal) assert.equal(result.reports[1].reason_code, 'task_aborted_after_fatal_failure');
    assert.equal(sha256File(formal), original);
    assert.deepEqual(fs.readdirSync(path.dirname(formal)), [path.basename(formal)]);
    assert.deepEqual(result.reports[0].files, []);
    assert.ok(result.reports[0].diagnostics.field_path);
    assert.ok(result.reports[0].diagnostics.failure_kind);
    assert.equal(JSON.stringify(result.reports[0].diagnostics).includes('999'), false);
    assert.equal(h.state.staging.every(directory => !fs.existsSync(directory)), true);
  }
});

function temporaryRoot(t, prefix = 'export-v3-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function rowFor(spec, seed = '1') {
  const row = Array(spec.headers.length).fill('value');
  for (const key of spec.required_key_columns) row[spec.headers.indexOf(key)] = seed;
  return row;
}

function generatedRunner(status, state = {}) {
  return async (input, dependencies) => {
    state.browsers ||= []; state.staging ||= []; state.inputs ||= []; state.dependencies ||= [];
    state.browsers.push(dependencies.browser); state.staging.push(input.outputDir);
    state.inputs.push(input); state.dependencies.push(dependencies);
    const rows = status === 'no_data' ? [input.reportSpec.headers] : [input.reportSpec.headers, rowFor(input.reportSpec)];
    const outputFile = path.join(input.outputDir, 'generated.xlsx'); writeWorkbook(outputFile, rows);
    const stat = fs.statSync(outputFile);
    return {
      status, shop_id: String(input.shop.seller_id), output_file: outputFile,
      byte_length: stat.size, sha256: sha256File(outputFile), generated_file: true,
      row_count: status === 'no_data' ? 0 : 1,
    };
  };
}

function harness(t, behaviors, options = {}) {
  const base = temporaryRoot(t); const dataRoot = path.join(base, 'data'); fs.mkdirSync(dataRoot);
  const shopRoot = path.join(dataRoot, '测试店__88001'); const state = {
    loads: 0, sessions: 0, closes: 0, staging: [], browser: null, shopRoot,
  };
  const page = { url: () => SELLER_URL };
  const browserContext = { pages: () => options.pages ? options.pages(state, page) : [page] };
  const browser = {
    isConnected: () => options.connected ? options.connected(state) : true,
    contexts: () => options.contexts ? options.contexts(state, browserContext) : [browserContext],
  };
  state.browser = browser;
  const requireModule = (file) => {
    const parent = path.basename(path.dirname(file)); const reportId = path.basename(file, '.js');
    if (behaviors[reportId]) return { run: behaviors[reportId] };
    if (parent !== 'common') return { provider_id: parent, entryUrl: () => SELLER_URL };
    return options.moduleFor ? options.moduleFor(reportId, behaviors) : { run: behaviors[reportId] };
  };
  const loaded = options.loaded || loadReportMd();
  const dependencies = {
    loadReportMd: () => { state.loads += 1; return loaded; },
    requireModule,
    createRunSession: async (request, sessionDependencies) => {
      state.sessions += 1;
      const parsed = parseRunRequest(request, { loaded: sessionDependencies.loaded });
      const providerId = options.providerId || 'local';
      const frozenIdentity = {
        shop_type: providerId, shop_code: 'SHOP001', seller_type: providerId === 'local' ? 2 : 1,
        business_type: providerId === 'local' ? 1 : 2, shop_region: 'PH',
        region_code: providerId === 'local' ? 'PH' : 'CN',
        seller_hostname: providerId === 'local' ? 'seller-ph.tiktok.com' : 'seller.tiktokshopglobalselling.com',
      };
      return {
        browser, browserContext,
        runContext: {
          request_id: options.requestId || 'request-001', collection_date: options.collectionDate || '2026-09-01',
          collection_timezone: 'Asia/Manila', shop_id: '88001', seller_id: '88001',
          shop_name: '测试店', browser_id: '7', advertiser_id: options.advertiserId || null,
          advertiser_name: options.advertiserName || null, advertiser_currency: options.advertiserCurrency || null, business_center_id: options.businessCenterId || null,
          provider_id: providerId, ...frozenIdentity, shop_root: shopRoot,
          start_date: parsed.start_date, end_date: parsed.end_date, report_ids: parsed.report_ids,
          campaign_ref: parsed.campaign_ref, product_ref: parsed.product_ref,
          a: { status: 'ready', shop_alias: '测试店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222' },
          b: { status: 'operable', requested_shop_alias: '测试店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222', seller_page_url: SELLER_URL },
          shop: { status: 'identified', shop_alias: '测试店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222', provider_id: providerId, seller_id: '88001', ...frozenIdentity },
        },
        close: async () => { state.closes += 1; },
      };
    },
    makeStagingDir: () => {
      const directory = fs.mkdtempSync(path.join(base, 'stage-')); state.staging.push(directory); return directory;
    },
  };
  return { base, dependencies, state };
}

function advertiserOfficialSpec(base) {
  const skillRoot = path.join(base, 'skill'); const runner = 'scripts/routes/cross_border/advertiser_fixture.js';
  fs.mkdirSync(path.join(skillRoot, 'scripts', 'routes', 'cross_border'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, ...runner.split('/')), "'use strict';\n");
  return validateReportSpec({
    schema_version: 'report_spec_v1', report_id: 'advertiser_fixture', enabled: true, explicit_only: false,
    owner_scope: 'advertiser', required_variables: ['shop', 'advertiser'], source_type: 'official_download',
    success_output_type: 'official_xlsx', no_data_output_type: 'generated_xlsx',
    no_data_rule: 'trusted_zero', headers: ['ID', '名称'], required_key_columns: ['ID'],
    time_semantics: 'current_snapshot', output_granularity: 'snapshot', providers: { cross_border: { runner, official_validation: { kind: 'fixture' } } },
    output_path_template: '广告户数据/测试/{{time_file}}',
  }, { skillRoot });
}

test('real MD exposes only provider runners and export source has no report registry or old entry imports', () => {
  const loaded = loadReportMd(); const reportIds = Object.values(loaded.specs)
    .filter((spec) => spec.enabled).map((spec) => spec.report_id);
  assert.equal(reportIds.every((reportId) => Object.keys(loaded.specs[reportId].providers).length > 0), true);
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'export.js'), 'utf8');
  for (const reportId of reportIds) assert.equal(source.includes(reportId), false);
});

test('logical tables are encoded in product-performance filenames without an extra directory', (t) => {
  const spec = loadReportMd().specs.shop_product_daily_performance;
  const context = {
    shop_name: '测试店', shop_id: '88001', start_date: '2026-08-15', end_date: '2026-08-17',
  };
  const expected = new Map([
    ['total', '整体'], ['self_live', '商家直播'], ['self_video', '商家短视频'],
    ['affiliate_content', '联盟'], ['product_card', '商品卡'],
  ]);
  const shopRoot = path.join(temporaryRoot(t), '测试店__88001');
  for (const [logicalTable, outputDirectory] of expected) {
    const artifact = { logical_table: logicalTable };
    const variables = outputVariables(spec, context, artifact);
    assert.equal(variables.logical_table, outputDirectory);
    assert.equal(artifact.logical_table, logicalTable);
    assert.equal(
      renderOutputPath(spec, shopRoot, variables),
      path.join(shopRoot, '店铺数据', '商品表现', `${outputDirectory}__2026-08-15_至_2026-08-17.xlsx`),
    );
  }
});

test('all snapshot reports use one frozen collection date and reject missing or invalid dates', () => {
  const snapshotSpecs = Object.values(loadReportMd().specs).filter((spec) => spec.output_granularity === 'snapshot');
  assert.deepEqual(snapshotSpecs.map((spec) => spec.report_id).sort(), [
    'advertiser_account_status_snapshot',
    'fulfillment_performance_snapshot',
    'gmvmax_campaign_current_configuration_snapshot',
    'gmvmax_campaign_recommendation_snapshot',
    'inventory_snapshot',
    'returns_refunds_snapshot',
    'shop_health_snapshot',
    'shop_product_commercial_status_snapshot',
    'shop_product_growth_opportunity_snapshot',
  ]);
  const context = {
    collection_date:'2026-09-01', shop_name:'测试店', shop_id:'88001',
    advertiser_id:'22001', advertiser_name:'广告户',
  };
  for (const spec of snapshotSpecs) {
    const artifact = {
      campaign_id:'33001', campaign_name:'计划',
      ...(spec.logical_tables?.length ? { logical_table:spec.logical_tables[0].logical_table } : {}),
    };
    const prefixes = [];
    if (spec.owner_scope === 'advertiser') prefixes.push('广告户');
    if (['campaign','product'].includes(spec.owner_scope)) prefixes.push('计划');
    if (artifact.logical_table) prefixes.push(spec.logical_tables[0].output_directory || artifact.logical_table);
    const expectedPrefix = prefixes.length ? `${prefixes.join('__')}__` : '';
    assert.equal(outputVariables(spec, context, artifact).time_file, `${expectedPrefix}2026-09-01.xlsx`, spec.report_id);
  }
  const inventory = snapshotSpecs.find((spec) => spec.report_id === 'inventory_snapshot');
  assert.throws(() => outputVariables(inventory, { ...context, collection_date:null }), { code:'collection_date_output_invalid' });
  assert.throws(() => outputVariables(inventory, { ...context, collection_date:'2026-02-30' }), { code:'collection_date_output_invalid' });
});

test('unified GMV Max reports use one directory and distinguish single-day from range filenames', () => {
  const specs = loadReportMd().specs;
  const base = { shop_name:'店', shop_id:'88001', advertiser_id:'22001', advertiser_name:'广告户' };
  const campaign = { campaign_id:'33001', campaign_name:'计划' };
  for (const reportId of ['gmvmax_campaign_performance', 'gmvmax_campaign_product_performance']) {
    const spec = specs[reportId];
    assert.equal(outputVariables(spec, { ...base, start_date:'2026-08-26', end_date:'2026-08-26' }, campaign).time_file, '计划__2026-08-26.xlsx');
    assert.equal(outputVariables(spec, { ...base, start_date:'2026-08-01', end_date:'2026-08-31' }, campaign).time_file, '计划__2026-08-01_至_2026-08-31.xlsx');
  }
  assert.match(specs.gmvmax_campaign_performance.output_path_template, /\/GMV Max 计划表现\/\{\{time_file\}\}$/u);
  assert.match(specs.gmvmax_campaign_product_performance.output_path_template, /\/GMV Max 计划商品表现\/\{\{time_file\}\}$/u);
});

test('scoped product filenames preserve distinguishing suffixes when display names are long', () => {
  const spec = loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  const context = {
    shop_name:'店', shop_id:'88001', advertiser_id:'22001', advertiser_name:'广告户',
    start_date:'2026-08-26', end_date:'2026-08-26',
  };
  const common = 'Nylon Mosquito Net '.repeat(8);
  const first = outputVariables(spec, context, {
    campaign_id:'33001', campaign_name:'计划', product_id:'44001', product_name:`${common}Single Size`,
  }).time_file;
  const second = outputVariables(spec, context, {
    campaign_id:'33001', campaign_name:'计划', product_id:'44002', product_name:`${common}Queen Size`,
  }).time_file;
  assert.notEqual(first, second);
  assert.match(first, /Single Size/u);
  assert.match(second, /Queen Size/u);
});

test('scoped product filenames distinguish duplicate display names without exposing product ids', () => {
  const spec = loadReportMd().specs.gmvmax_campaign_product_creative_performance;
  const context = {
    shop_name:'店', shop_id:'88001', advertiser_id:'22001', advertiser_name:'广告户',
    start_date:'2026-08-26', end_date:'2026-08-26',
  };
  const first = outputVariables(spec, context, {
    campaign_id:'33001', campaign_name:'计划', product_id:'1731934875769407479', product_name:'同名商品',
  }).time_file;
  const second = outputVariables(spec, context, {
    campaign_id:'33001', campaign_name:'计划', product_id:'1732380057700370423', product_name:'同名商品',
  }).time_file;
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /1731934875769407479/u);
  assert.doesNotMatch(second, /1732380057700370423/u);
});

test('invalid requests fail before session while v2 runner ABI is checked only after identity', async (t) => {
  const first = harness(t, {});
  let earlyRunnerLoads = 0; first.dependencies.requireModule = () => { earlyRunnerLoads += 1; throw new Error('runner_must_not_load'); };
  const invalid = await executeExport({ shop: '店', report_scopes: ['all'] }, first.dependencies);
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.reason_code, 'report_alias_unknown');
  assert.equal(first.state.sessions, 0); assert.equal(first.state.loads, 1); assert.equal(earlyRunnerLoads, 0);
  const missingDates = await executeExport({ shop: '店', report_scopes: ['report:affiliate_center_performance'] }, first.dependencies);
  assert.equal(missingDates.status, 'failed'); assert.equal(missingDates.reason_code, 'date_range_required');
  assert.equal(first.state.sessions, 0); assert.equal(first.state.loads, 2); assert.equal(earlyRunnerLoads, 0);
  const second = harness(t, {}, { moduleFor: () => ({}) });
  const missing = await executeExport({ shop: '店', report_scopes: ['scope:inventory'] }, second.dependencies);
  assert.equal(missing.status, 'failed'); assert.equal(missing.reports[0].reason_code, 'report_runner_abi_invalid');
  assert.equal(second.state.sessions, 1); assert.equal(second.state.loads, 1);
  const oldShape = await executeExport({ shop: '店', report_scopes: ['scope:inventory'], logical_job: {} }, second.dependencies);
  assert.equal(oldShape.status, 'failed'); assert.equal(oldShape.reports.length, 0); assert.equal(second.state.sessions, 1);
});

test('disabled reports fail before session staging and runner loading for every scope', async (t) => {
  for (const reportId of DISABLED_REPORT_IDS) {
    const fixture = harness(t, {}); let runnerLoads = 0;
    fixture.dependencies.requireModule = () => { runnerLoads += 1; throw new Error('runner_must_not_load'); };
    const result = await executeExport({
      shop: '店', report_scopes: [`report:${reportId}`], start_date: '2026-08-20', end_date: '2026-08-20',
      advertiser: '222', campaign: '123', product: '456',
    }, fixture.dependencies);
    assert.equal(result.status, 'failed', reportId);
    assert.equal(result.reason_code, 'report_disabled', reportId);
    assert.equal(fixture.state.sessions, 0, reportId);
    assert.equal(fixture.state.staging.length, 0, reportId);
    assert.equal(runnerLoads, 0, reportId);
  }
});

test('product daily loads only the runner selected by the frozen provider on both sides', async (t) => {
  const loaded = loadReportMd(); const spec = loaded.specs.shop_product_daily_performance;
  const runnerPath = spec.providers.cross_border.runner; let runnerCalls = 0;
  const cross = harness(t, {}, { loaded, providerId: 'cross_border' }); const crossLoads = [];
  cross.dependencies.requireModule = (file) => {
    const relative = path.relative(loaded.skill_root, file).replaceAll('\\', '/'); crossLoads.push(relative);
    if (relative === runnerPath) return { run: async (input) => { runnerCalls += 1; assert.equal(input.providerSpec, spec.providers.cross_border); assert.equal('route' in input, false); throw Object.assign(new Error('source'), { code: 'source_unavailable' }); } };
    throw new Error(`unexpected module ${relative}`);
  };
  const crossResult = await executeExport({
    shop: '店', report_scopes: ['shop_product_daily_performance'], start_date: '2026-08-15', end_date: '2026-08-15',
  }, cross.dependencies);
  assert.equal(crossResult.reports[0].reason_code, 'source_unavailable');
  assert.equal(runnerCalls, 1);
  assert.deepEqual(crossLoads, [runnerPath]);

  const localRunnerPath = spec.providers.local.runner; let localRuns = 0; const localLoads = [];
  const local = harness(t, {}, { loaded, providerId: 'local' });
  local.dependencies.requireModule = (file) => {
    const relative = path.relative(loaded.skill_root, file).replaceAll('\\', '/'); localLoads.push(relative);
    if (relative === localRunnerPath) return { run: async (input) => { localRuns += 1; assert.equal(input.providerSpec, spec.providers.local); throw Object.assign(new Error('source'), { code: 'source_unavailable' }); } };
    throw new Error(`unexpected module ${relative}`);
  };
  const localResult = await executeExport({
    shop: '店', report_scopes: ['shop_product_daily_performance'], start_date: '2026-08-15', end_date: '2026-08-15',
  }, local.dependencies);
  assert.equal(localResult.reports[0].reason_code, 'source_unavailable');
  assert.equal(localRuns, 1);
  assert.deepEqual(localLoads, [localRunnerPath]);
});

test('inventory loads only the selected provider runner after identity and passes its exact MD node', async (t) => {
  const loaded = loadReportMd(); const spec = loaded.specs.inventory_snapshot;
  for (const [providerId, expectedStatus] of [['cross_border', 'success'], ['local', 'no_data']]) {
    const runnerState = {}; const events = [];
    const fixture = harness(t, {}, { loaded, providerId });
    const createSession = fixture.dependencies.createRunSession;
    fixture.dependencies.createRunSession = async (...args) => { events.push('identity'); return createSession(...args); };
    fixture.dependencies.requireModule = (file) => {
      const relative = path.relative(loaded.skill_root, file).replaceAll('\\', '/'); events.push(`load:${relative}`);
      if (relative !== spec.providers[providerId].runner) throw new Error('unselected_inventory_runner_must_not_load');
      return { run: generatedRunner(expectedStatus, runnerState) };
    };
    const result = await executeExport({ shop: '店', report_scopes: ['inventory_snapshot'] }, fixture.dependencies);
    assert.equal(result.status, expectedStatus);
    assert.equal(result.reports[0].status, expectedStatus);
    assert.equal(result.reports[0].files[0], path.join(
      fixture.state.shopRoot, '店铺数据', '库存快照', '2026-09-01.xlsx',
    ));
    assert.deepEqual(events, ['identity', `load:${spec.providers[providerId].runner}`]);
    assert.equal(runnerState.inputs.length, 1);
    assert.equal(runnerState.inputs[0].providerSpec, spec.providers[providerId]);
    assert.equal('route' in runnerState.inputs[0], false);
  }
});

test('manual cost table is ensured once after identity binding and before every report runner', async (t) => {
  const loaded = loadReportMd(); const events = []; const ensuredRoots = [];
  const behaviors = {
    inventory_snapshot: generatedRunner('success'),
    shop_health_snapshot: generatedRunner('success'),
  };
  const fixture = harness(t, behaviors, { loaded, providerId: 'local' });
  const createSession = fixture.dependencies.createRunSession;
  fixture.dependencies.createRunSession = async (...args) => {
    const session = await createSession(...args); events.push('identity'); return session;
  };
  fixture.dependencies.ensureManualCostTable = (shopRoot) => {
    ensuredRoots.push(shopRoot); events.push('manual-cost');
  };
  fixture.dependencies.requireModule = (file) => {
    const reportId = path.basename(file, '.js');
    return { run: async (...args) => { events.push(`runner:${reportId}`); return behaviors[reportId](...args); } };
  };

  const result = await executeExport({
    shop: '店', report_scopes: ['inventory_snapshot', 'shop_health_snapshot'],
  }, fixture.dependencies);

  assert.equal(result.status, 'success');
  assert.deepEqual(ensuredRoots, [fixture.state.shopRoot]);
  assert.deepEqual(events, ['identity', 'manual-cost', 'runner:inventory_snapshot', 'runner:shop_health_snapshot']);
  assert.equal(Object.hasOwn(result, 'warnings'), false);
});

test('binding failure does not ensure the manual cost table', async (t) => {
  const fixture = harness(t, {}); let ensureCalls = 0;
  const createSession = fixture.dependencies.createRunSession;
  fixture.dependencies.createRunSession = async (...args) => {
    const session = await createSession(...args);
    session.runContext.shop.seller_id = '99001';
    return session;
  };
  fixture.dependencies.ensureManualCostTable = () => { ensureCalls += 1; };

  const result = await executeExport({ shop: '店', report_scopes: ['inventory_snapshot'] }, fixture.dependencies);
  assert.equal(result.status, 'failed');
  assert.equal(result.reports[0].reason_code, 'provider_binding_invalid');
  assert.equal(ensureCalls, 0);
});

test('manual cost table creation failure warns without blocking the report', async (t) => {
  const fixture = harness(t, { inventory_snapshot: generatedRunner('success') });
  fixture.dependencies.ensureManualCostTable = () => {
    throw Object.assign(new Error('disk unavailable'), { code: 'EACCES' });
  };

  const result = await executeExport({ shop: '店', report_scopes: ['inventory_snapshot'] }, fixture.dependencies);
  assert.equal(result.status, 'success');
  assert.equal(result.reports[0].status, 'success');
  assert.deepEqual(result.warnings, [{
    code: 'manual_cost_table_create_failed',
    reason_code: 'EACCES',
    file: path.join(fixture.state.shopRoot, '15_人工录入', '成本表.xlsx'),
  }]);
});

test('runner inputs and advertiser identity are projected by each report required variables', async (t) => {
  const loaded = loadReportMd();
  const campaignId = '1870130072117617'; const productId = '1735820935607387499';
  const campaignName = '计划'; const productName = '商品'; const received = {};
  const makeSingleResult = (input, advertiserId = null) => {
    const outputFile = path.join(input.outputDir, `${input.reportSpec.report_id}.xlsx`);
    writeWorkbook(outputFile, [['header'], ['data']]);
    return {
      status: 'success', shop_id: '88001', advertiser_id: advertiserId,
      output_file: outputFile, byte_length: fs.statSync(outputFile).size,
      sha256: sha256File(outputFile), official_file_unchanged: true, data_row_count: 1,
      ...(input.reportSpec.currency_contract ? { currency_evidence: {
        currency_code: 'PHP', currency_symbol: '₱',
        currency_source: 'official_report_page_symbol', amount_scope: 'all_monetary_fields',
      } } : {}),
    };
  };
  const makeResult = (input, artifact) => {
    const outputFile = path.join(input.outputDir, `${input.reportSpec.report_id}.xlsx`);
    writeWorkbook(outputFile, [['header'], ['data']]);
    return {
      status: 'success', shop_id: '88001', advertiser_id: '22001', business_center_id: '33001',
      artifacts: [{
        status: 'success', ...artifact, output_file: outputFile, byte_length: fs.statSync(outputFile).size,
        sha256: sha256File(outputFile), official_file_unchanged: true, data_row_count: 1,
      }],
    };
  };
  const makeAdvertiserResult = (input) => {
    const outputFile = path.join(input.outputDir, `${input.reportSpec.report_id}.xlsx`);
    writeWorkbook(outputFile, [input.reportSpec.headers, rowFor(input.reportSpec)]);
    return {
      status: 'success', shop_id: '88001', advertiser_id: '22001', business_center_id: '33001',
      output_file: outputFile, byte_length: fs.statSync(outputFile).size,
      sha256: sha256File(outputFile), generated_file: true, row_count: 1,
    };
  };
  const fixture = harness(t, {
    shop_promotion_performance: async (input) => {
      received.shop = input;
      return makeSingleResult(input);
    },
    advertiser_account_status_snapshot: async (input) => {
      received.advertiser = input;
      return makeAdvertiserResult(input);
    },
    gmvmax_campaign_product_performance: async (input) => {
      received.campaign = input;
      return makeResult(input, { campaign_id: campaignId, campaign_name: campaignName });
    },
    gmvmax_campaign_product_creative_performance: async (input) => {
      received.product = input;
      return makeResult(input, {
        campaign_id: campaignId, campaign_name: campaignName,
        product_id: productId, product_name: productName,
      });
    },
  }, {
    loaded, providerId: 'cross_border', advertiserId: '22001', advertiserName: '广告户', advertiserCurrency: 'USD', businessCenterId: '33001',
  });
  const result = await executeExport({
    shop: '店', campaign: campaignId, product: productId,
    report_scopes: ['shop_promotion_performance', 'advertiser_account_status_snapshot', 'gmvmax_campaign_product_performance', 'gmvmax_campaign_product_creative_performance'],
    start_date: '2026-08-20', end_date: '2026-08-20',
  }, fixture.dependencies);
  assert.equal(result.status, 'success'); assert.equal(result.reports.length, 4);
  assert.equal(result.reports.every((report) => report.status === 'success'), true);
  for (const field of ['advertiserId', 'advertiserName', 'advertiserCurrency', 'businessCenterId', 'campaignRef', 'productRef']) {
    assert.equal(Object.hasOwn(received.shop, field), false, field);
  }
  assert.equal(received.shop.startDate, '2026-08-20'); assert.equal(received.shop.endDate, '2026-08-20');
  assert.equal(received.advertiser.advertiserId, '22001'); assert.equal(received.advertiser.advertiserName, '广告户');
  assert.equal(received.advertiser.businessCenterId, '33001');
  assert.equal(received.advertiser.advertiserCurrency, 'USD');
  for (const field of ['startDate', 'endDate', 'campaignRef', 'productRef']) {
    assert.equal(Object.hasOwn(received.advertiser, field), false, field);
  }
  assert.equal(received.campaign.advertiserId, '22001'); assert.equal(received.campaign.advertiserName, '广告户');
  assert.equal(received.campaign.businessCenterId, '33001'); assert.equal(received.campaign.campaignRef, campaignId);
  assert.equal(received.campaign.advertiserCurrency, 'USD');
  assert.equal(Object.hasOwn(received.campaign, 'productRef'), false);
  assert.equal(received.product.campaignRef, campaignId); assert.equal(received.product.productRef, productId);
  assert.equal(received.product.advertiserId, '22001'); assert.equal(received.product.advertiserName, '广告户');
  assert.equal(received.product.businessCenterId, '33001');
  assert.equal(received.product.advertiserCurrency, 'USD');
  assert.equal(result.reports[2].artifacts[0].product_id, undefined);
  const creativeSheet = readFirstWorksheet(fs.readFileSync(result.reports[3].files[0]));
  const productColumn = creativeSheet.headers.indexOf('product_id');
  assert.ok(productColumn >= 0); assert.equal(creativeSheet.rows[1][productColumn], productId);

  const mismatched = harness(t, {
    shop_promotion_performance: async (input) => makeSingleResult(input, '99001'),
  }, {
    loaded, providerId: 'cross_border', advertiserId: '22001', advertiserName: '广告户', businessCenterId: '33001',
  });
  const mismatchResult = await executeExport({
    shop: '店', report_scopes: ['shop_promotion_performance'],
    start_date: '2026-08-20', end_date: '2026-08-20',
  }, mismatched.dependencies);
  assert.equal(mismatchResult.status, 'failed');
  assert.equal(mismatchResult.reports[0].reason_code, 'result_advertiser_identity_mismatch');
});

test('product selectors still reject mismatches while unrelated selectors allow campaign empty no_data', async (t) => {
  const loaded = loadReportMd();
  const campaignId = '1870130072117617'; const productId = '1735820935607387499';
  const options = {
    loaded, providerId: 'cross_border', advertiserId: '22001', advertiserName: '广告户', businessCenterId: '33001',
  };
  const empty = harness(t, {
    gmvmax_campaign_product_performance: async (input) => ({
      status: 'no_data', shop_id: '88001', advertiser_id: '22001', business_center_id: '33001', artifacts: [],
    }),
    gmvmax_campaign_product_creative_performance: async (input) => {
      throw Object.assign(new Error('stop after selector input'), { code: 'source_unavailable' });
    },
  }, options);
  const emptyResult = await executeExport({
    shop: '店', product: productId,
    report_scopes: ['gmvmax_campaign_product_performance', 'gmvmax_campaign_product_creative_performance'],
    start_date: '2026-08-20', end_date: '2026-08-20',
  }, empty.dependencies);
  assert.equal(emptyResult.reports[0].status, 'no_data');
  assert.equal(emptyResult.reports[1].reason_code, 'source_unavailable');

  const mismatch = harness(t, {
    gmvmax_campaign_product_creative_performance: async (input) => {
      const outputFile = path.join(input.outputDir, 'wrong-product.xlsx'); writeWorkbook(outputFile, [['header'], ['data']]);
      return {
        status: 'success', shop_id: '88001', advertiser_id: '22001', business_center_id: '33001',
        artifacts: [{
          status: 'success', campaign_id: campaignId, campaign_name: '计划', product_id: '999', product_name: '错误商品',
           output_file: outputFile, byte_length: fs.statSync(outputFile).size,
          sha256: sha256File(outputFile), official_file_unchanged: true, data_row_count: 1,
        }],
      };
    },
  }, options);
  const mismatchResult = await executeExport({
    shop: '店', campaign: campaignId, product: productId,
    report_scopes: ['gmvmax_campaign_product_creative_performance'],
    start_date: '2026-08-20', end_date: '2026-08-20',
  }, mismatch.dependencies);
  assert.equal(mismatchResult.reports[0].reason_code, 'result_product_identity_mismatch');
});

test('v2 provider selection is pure and runner loading consumes only the selected node', () => {
  const loaded = loadReportMd(); const spec = loaded.specs.inventory_snapshot; let loads = 0; let validated = null;
  const provider = selectProvider(spec, 'cross_border');
  assert.equal(provider, spec.providers.cross_border); assert.equal(loads, 0);
  const run = () => {};
  assert.equal(loadProviderRunner(loaded.skill_root, spec, provider, (file) => {
    loads += 1;
    assert.equal(path.relative(loaded.skill_root, file).replaceAll('\\', '/'), provider.runner);
    return { run, validateSpec: (receivedSpec, receivedProvider) => { validated = [receivedSpec, receivedProvider]; } };
  }), run);
  assert.equal(loads, 1); assert.deepEqual(validated, [spec, provider]);
  assert.throws(() => selectProvider(spec, 'missing'), { code: 'report_provider_unsupported' });
});

test('inventory unsupported provider and selected runner failure never stage or load the other side', async (t) => {
  const loaded = loadReportMd(); const unsupportedLoaded = structuredClone(loaded);
  unsupportedLoaded.skill_root = loaded.skill_root;
  delete unsupportedLoaded.specs.inventory_snapshot.providers.local;
  const unsupported = harness(t, {}, { loaded: unsupportedLoaded, providerId: 'local' }); let unsupportedLoads = 0;
  unsupported.dependencies.requireModule = () => { unsupportedLoads += 1; throw new Error('runner_must_not_load'); };
  const missing = await executeExport({ shop: '店', report_scopes: ['inventory_snapshot'] }, unsupported.dependencies);
  assert.equal(missing.reports[0].reason_code, 'report_provider_unsupported');
  assert.equal(unsupportedLoads, 0); assert.equal(unsupported.state.staging.length, 0);

  const failed = harness(t, {}, { loaded, providerId: 'cross_border' }); const loads = [];
  failed.dependencies.requireModule = (file) => {
    const relative = path.relative(loaded.skill_root, file).replaceAll('\\', '/'); loads.push(relative);
    if (relative !== loaded.specs.inventory_snapshot.providers.cross_border.runner) throw new Error('local_runner_must_not_load');
    return { run: async () => { throw Object.assign(new Error('selected'), { code: 'source_unavailable' }); } };
  };
  const result = await executeExport({ shop: '店', report_scopes: ['inventory_snapshot'] }, failed.dependencies);
  assert.equal(result.reports[0].reason_code, 'source_unavailable');
  assert.deepEqual(loads, [loaded.specs.inventory_snapshot.providers.cross_border.runner]);
  assert.equal(failed.state.staging.length, 1);
});

test('dual-provider reports load only the runner selected by frozen identity', async (t) => {
  const loaded=loadReportMd();
  for(const reportId of ['shop_product_daily_performance','product_analytics_performance','affiliate_center_performance','shop_product_growth_opportunity_snapshot','shop_product_commercial_status_snapshot','manage_orders_csv','shop_video_performance','gmvmax_campaign_product_performance','gmvmax_campaign_product_creative_performance','gmvmax_campaign_current_configuration_snapshot','gmvmax_campaign_change_log','gmvmax_campaign_recommendation_snapshot'])for(const providerId of ['cross_border','local']){
    const spec=loaded.specs[reportId];const selected=spec.providers[providerId];const loads=[];const run=harness(t,{}, {loaded,providerId});
    run.dependencies.requireModule=(file)=>{const relative=path.relative(loaded.skill_root,file).replaceAll('\\','/');loads.push(relative);assert.equal(relative,selected.runner);return{run:async(input)=>{assert.equal(input.providerSpec,selected);assert.equal(input.shop.provider_id,providerId);throw Object.assign(new Error('source'),{code:'source_unavailable'});}};};
    const result=await executeExport({shop:'店',report_scopes:[reportId],start_date:'2026-08-20',end_date:'2026-08-20'},run.dependencies);
    assert.equal(result.reports[0].reason_code,'source_unavailable');assert.deepEqual(loads,[selected.runner]);
  }
});

test('migrated common modules expose no external business runner or browser decisions', () => {
  for (const file of [
    'shop_product_daily_performance_v3.js',
    'affiliate_center_performance_v3.js',
    'product_analytics_performance_v3.js',
    'manage_orders_csv_v3.js',
    'gmvmax_campaign_overview_v3.js',
    'gmvmax_campaign_product_creative_performance_v3.js',
    'gmvmax_campaign_hourly_performance_v3.js',
    'gmvmax_campaign_performance_interval_v3.js',
    'shop_video_performance_v3.js',
    'gmvmax_campaign_current_configuration_snapshot_v3.js',
    'gmvmax_campaign_recommendation_snapshot_v3.js',
    'shop_product_growth_opportunity_snapshot_v3.js',
    'shop_product_commercial_status_snapshot_v3.js',
    'advertiser_account_status_snapshot_v3.js',
    'gmvmax_campaign_change_log_v3.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'routes', 'common', file), 'utf8');
    assert.doesNotMatch(source, /\brun\s*[:=]|\.goto\(|waitFor(?:Response|Request|Event)|\.locator\(|endpoint_path|entry_path/u);
  }
});

test('one official-download spec selects official success bytes or generated trusted-zero by result status', (t) => {
  const base = temporaryRoot(t, 'export-effective-output-'); const spec = advertiserOfficialSpec(base);
  const staging = path.join(base, 'staging'); fs.mkdirSync(staging);
  const context = {
    seller_id: '88001', shop_name: '店', shop_id: '88001', browser_id: '7', provider_id: 'local',
    advertiser_id: '22001', advertiser_name: '广告户', business_center_id: '33001',
    shop_root: path.join(base, 'shop'), request_id: 'request-effective', collection_date:'2026-09-01',
    start_date: null, end_date: null,
  };
  const officialFile = path.join(staging, 'official.xlsx'); writeWorkbook(officialFile, [['official'], ['bytes']]);
  const officialResult = {
    status: 'success', shop_id: '88001', advertiser_id: '22001', business_center_id: '33001',
    output_file: officialFile, byte_length: fs.statSync(officialFile).size, sha256: sha256File(officialFile),
    official_file_unchanged: true, data_row_count: 1,
  };
  const success = publishRunnerOutput(officialResult, spec, context, staging);
  assert.equal(success.status, 'success'); assert.deepEqual(fs.readFileSync(success.files[0]), fs.readFileSync(officialFile));

  const emptyFile = path.join(staging, 'empty.xlsx'); writeWorkbook(emptyFile, [spec.headers]);
  const emptyResult = {
    status: 'no_data', shop_id: '88001', advertiser_id: '22001',
    output_file: emptyFile, byte_length: fs.statSync(emptyFile).size, sha256: sha256File(emptyFile),
    generated_file: true, row_count: 0,
  };
  const noData = publishRunnerOutput(emptyResult, spec, context, staging);
  assert.equal(noData.status, 'no_data'); assert.equal(noData.files[0], success.files[0]);
  assert.deepEqual(fs.readFileSync(noData.files[0]), fs.readFileSync(emptyFile));

  fs.writeFileSync(noData.files[0], 'old');
  assert.throws(() => inspectRunnerOutput({ ...emptyResult, generated_file: false }, spec, context, staging), { code: 'runner_output_contract_invalid' });
  assert.throws(() => inspectRunnerOutput({ ...emptyResult, status: 'success' }, spec, context, staging), { code: 'runner_output_contract_invalid' });
  assert.equal(fs.readFileSync(noData.files[0], 'utf8'), 'old');
});

test('report aggregation preserves success no_data partial and fatal semantics', () => {
  assert.equal(require('../scripts/export').aggregateStatus([{ status: 'no_data' }], false), 'no_data');
  assert.equal(require('../scripts/export').aggregateStatus([{ status: 'success' }, { status: 'no_data' }], false), 'success');
  assert.equal(require('../scripts/export').aggregateStatus([{ status: 'success' }, { status: 'failed' }], false), 'partial');
  assert.equal(require('../scripts/export').aggregateStatus([{ status: 'success' }], true), 'failed');
});

test('advertiser runner receives frozen context values and identity omission or mismatch is fatal', async (t) => {
  const base = temporaryRoot(t, 'export-advertiser-identity-');
  const spec = {
    report_id: 'advertiser_fixture', enabled: true, owner_scope: 'advertiser', required_variables: ['shop', 'advertiser'],
    source_type: 'official_api', success_output_type: 'generated_xlsx', no_data_output_type: null,
    output_granularity: 'snapshot', output_path_template: '广告户数据/测试/{{time_file}}',
    headers: ['ID'], required_key_columns: ['ID'], providers: { cross_border: { runner: 'scripts/routes/cross_border/advertiser_fixture.js' } },
  };
  const loaded = {
    skill_root: path.join(__dirname, '..'),
    router: { reports: [{ report_id: spec.report_id, aliases: ['advertiser-fixture'] }], scopes: [] },
    specs: { [spec.report_id]: spec },
  };
  let received;
  const runner = async (input, dependencies) => {
    received = { input, dependencies };
    const outputFile = path.join(input.outputDir, 'result.xlsx'); writeWorkbook(outputFile, [spec.headers, ['1']]);
    return {
      status: 'success', shop_id: '88001', advertiser_id: '22001', business_center_id: '33001',
      output_file: outputFile, byte_length: fs.statSync(outputFile).size, sha256: sha256File(outputFile),
      generated_file: true, row_count: 1,
    };
  };
  const fixture = harness(t, { advertiser_fixture: runner }, {
    loaded, providerId: 'cross_border', advertiserId: '22001', advertiserName: '广告户', businessCenterId: '33001',
  });
  const result = await executeExport({ shop: '店', report_scopes: ['advertiser-fixture'] }, fixture.dependencies);
  assert.equal(result.status, 'success'); assert.equal(received.input.advertiserId, '22001');
  assert.equal(received.input.advertiserName, '广告户'); assert.equal(received.input.businessCenterId, '33001');
  assert.equal(received.dependencies.browserContext !== undefined, true);

  for (const advertiserId of [undefined, '99001']) {
    const bad = harness(t, {
      advertiser_fixture: async () => ({ status: 'success', shop_id: '88001', advertiser_id: advertiserId }),
    }, { loaded, providerId: 'cross_border', advertiserId: '22001', advertiserName: '广告户', businessCenterId: '33001' });
    const failed = await executeExport({ shop: '店', report_scopes: ['advertiser-fixture'] }, bad.dependencies);
    assert.equal(failed.status, 'failed'); assert.equal(failed.reports[0].reason_code, 'result_advertiser_identity_mismatch');
  }
});

test('CLI writes one result object and maps completed versus partial exit codes', async (t) => {
  const fixture = harness(t, { inventory_snapshot: generatedRunner('no_data') }); const lines = [];
  fixture.dependencies.writeLine = (value) => lines.push(value);
  const exit = await main(['--request-json', JSON.stringify({ shop: '店', report_scopes: ['scope:inventory'] })], fixture.dependencies);
  assert.equal(exit, 0); assert.equal(lines.length, 1); assert.equal(lines[0].status, 'no_data');
  const invalidLines = [];
  assert.equal(await main(['--bad'], { writeLine: (value) => invalidLines.push(value) }), 2);
  assert.equal(invalidLines.length, 1); assert.equal(invalidLines[0].status, 'failed');
});
