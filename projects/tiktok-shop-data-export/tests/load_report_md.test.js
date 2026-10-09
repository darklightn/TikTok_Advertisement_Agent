'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadReportMd, resolveReportIds } = require('../scripts/load-report-md');

function marked(kind, value) {
  return `<!-- ${kind}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${kind}:end -->\n`;
}
function specSection(section, value) { return `## ${section}\n\n${marked('report-spec', value)}`; }
function apiSpec(overrides = {}) {
  return {
    schema_version: 'report_spec_v1', report_id: 'api_report', enabled: true, explicit_only: false,
    owner_scope: 'shop', required_variables: ['shop', 'start_date', 'end_date'], source_type: 'official_api',
    success_output_type: 'generated_xlsx', no_data_output_type: 'generated_xlsx',
    time_semantics: 'requested_range', output_granularity: 'request_range',
    providers: { cross_border: { runner: 'scripts/routes/cross_border/api_report.js' } }, output_path_template: '店铺数据/API/{{time_file}}',
    headers: ['ID', '值'], required_key_columns: ['ID'], no_data_rule: 'trusted_source_zero',
    ...overrides,
  };
}
function officialSpec(overrides = {}) {
  return {
    schema_version: 'report_spec_v1', report_id: 'official_report', enabled: true, explicit_only: true,
    owner_scope: 'advertiser', required_variables: ['shop', 'advertiser', 'start_date', 'end_date'], source_type: 'official_download',
    success_output_type: 'official_csv', no_data_output_type: null,
    time_semantics: 'requested_range', output_granularity: 'source_segment',
    providers: { cross_border: { runner: 'scripts/routes/cross_border/official_report.js', official_validation: { kind: 'report_specific' } } }, output_path_template: '广告户数据/官方/{{segment_file}}',
    official_validation: { kind: 'report_specific' }, no_data_rule: 'not_applicable',
    ...overrides,
  };
}
function router(overrides = {}) {
  return {
    schema_version: 'report_router_v1',
    reports: [
      { report_id: 'api_report', aliases: ['API 报表'], md: 'reports/sample.md', section: 'api_report' },
      { report_id: 'official_report', aliases: ['官方报表'], md: 'reports/sample.md', section: 'official_report' },
    ],
    scopes: [{ aliases: ['组合报表'], report_ids: ['official_report', 'api_report'] }],
    ...overrides,
  };
}
function fixture(t, values = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-md-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'references', 'reports'), { recursive: true }); fs.mkdirSync(path.join(root, 'scripts', 'routes', 'cross_border'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'routes', 'cross_border', 'api_report.js'), "'use strict';\n"); fs.writeFileSync(path.join(root, 'scripts', 'routes', 'cross_border', 'official_report.js'), "'use strict';\n");
  fs.writeFileSync(path.join(root, 'references', 'report-router.md'), values.routerText || marked('report-router', values.router || router()));
  fs.writeFileSync(path.join(root, 'references', 'reports', 'sample.md'), values.specText || `${specSection('api_report', values.api || apiSpec())}${specSection('official_report', values.official || officialSpec())}`);
  return root;
}
function code(expected) { return (error) => error?.code === expected; }

const DISABLED_REPORT_IDS = [];

test('loads marked JSON and resolves direct aliases and ordered scopes', (t) => {
  const root = fixture(t); const loaded = loadReportMd({ skillRoot: root, routerPath: 'references/report-router.md' });
  assert.deepEqual(Object.keys(loaded.specs), ['api_report', 'official_report']);
  assert.deepEqual(resolveReportIds('  API   报表 ', loaded), ['api_report']);
  assert.deepEqual(resolveReportIds('组合报表', loaded), ['official_report', 'api_report']);
  assert.throws(() => resolveReportIds('不存在', loaded), code('report_alias_unknown'));
});

test('rejects missing markers and invalid JSON', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { routerText: '{}' }) }), code('report_router_marker_missing'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { routerText: '<!-- report-router:start -->\n{bad}\n<!-- report-router:end -->' }) }), code('report_router_json_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: '{}' }) }), code('report_spec_marker_missing'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: '## api_report\n\n<!-- report-spec:start -->\n{bad}\n<!-- report-spec:end -->' }) }), code('report_spec_json_invalid'));
});

test('binds each router section to the matching report spec', (t) => {
  const noHeading = `${marked('report-spec', apiSpec())}${specSection('official_report', officialSpec())}`;
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: noHeading }) }), code('report_section_missing'));
  const interveningText = `## api_report\n说明文字\n${marked('report-spec', apiSpec())}${specSection('official_report', officialSpec())}`;
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: interveningText }) }), code('report_section_missing'));
  const missing = router(); missing.reports[0].section = 'missing';
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { router: missing }) }), code('report_section_missing'));
  const mismatch = `${specSection('official_report', apiSpec())}${specSection('api_report', officialSpec())}`;
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: mismatch }) }), code('report_section_report_mismatch'));
  const repeated = `${specSection('api_report', apiSpec())}${specSection('api_report', officialSpec())}`;
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: repeated }) }), code('report_section_duplicate'));
});

test('rejects duplicate and ambiguous aliases', (t) => {
  const duplicate = router(); duplicate.reports[0].aliases.push('ＡＰＩ 报表');
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { router: duplicate }) }), code('report_router_alias_duplicate'));
  const ambiguous = router(); ambiguous.scopes[0].aliases = ['官方报表'];
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { router: ambiguous }) }), code('report_router_alias_ambiguous'));
});

test('rejects unknown and repeated report IDs in scopes', (t) => {
  const unknown = router(); unknown.scopes[0].report_ids = ['missing'];
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { router: unknown }) }), code('report_router_unknown_report'));
  const repeated = router(); repeated.scopes[0].report_ids = ['api_report', 'api_report'];
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { router: repeated }) }), code('report_router_invalid'));
});

test('rejects missing provider runners and invalid output template variables', (t) => {
  const root = fixture(t); fs.rmSync(path.join(root, 'scripts', 'routes', 'cross_border', 'api_report.js'));
  assert.throws(() => loadReportMd({ skillRoot: root }), code('report_provider_runner_missing'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ output_path_template: '店铺数据/{{token}}.xlsx' }) }) }), code('report_output_template_variable_invalid'));
  for (const outputPath of ['99_系统记录_不用看/a.xlsx', '/a.xlsx', '../99_系统记录_不用看/a.xlsx']) {
    assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ output_path_template: outputPath }) }) }), code('report_output_template_invalid'));
  }
});

test('enforces owner scopes and their required variable chains', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ owner_scope: 'account' }) }) }), code('report_spec_owner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ required_variables: ['shop', 'start_date'] }) }) }), code('report_spec_variables_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ required_variables: ['shop', 'token'] }) }) }), code('report_spec_variables_invalid'));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop', 'advertiser', 'start_date', 'end_date'],
  }) }) }));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop', 'advertiser', 'campaign', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit',
  }) }) }));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop', 'advertiser', 'campaign', 'start_date', 'end_date'],
  }) }) }), code('report_spec_campaign_selection_invalid'));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop', 'advertiser', 'campaign', 'product', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit', product_selection: 'all_or_explicit',
  }) }) }));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop', 'advertiser', 'campaign', 'product', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit',
  }) }) }), code('report_spec_product_selection_invalid'));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({
    owner_scope: 'campaign', required_variables: ['shop', 'advertiser', 'campaign', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit',
    output_path_template: '计划数据/报表/{{segment_file}}',
  }) }) }));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({
    owner_scope: 'product', required_variables: ['shop', 'advertiser', 'campaign', 'product', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit', product_selection: 'all_or_explicit',
    output_path_template: '计划数据/报表/{{segment_file}}',
  }) }) }));
});

test('binds date variables to time semantics and compatible granularity', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ required_variables: ['shop', 'start_date'] }) }) }), code('report_spec_time_variables_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ required_variables: ['shop'] }) }) }), code('report_spec_time_variables_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ time_semantics: 'current_snapshot' }) }) }), code('report_spec_time_variables_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ output_granularity: 'snapshot' }) }) }), code('report_spec_granularity_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ time_semantics: 'metric_date', output_granularity: 'request_range' }) }) }), code('report_spec_granularity_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop'], time_semantics: 'current_change_log', output_granularity: 'snapshot',
  }) }) }), code('report_spec_granularity_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ output_granularity: 'source_segment', output_path_template: '店铺数据/API/{{segment_file}}' }) }) }), code('report_spec_granularity_invalid'));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    time_semantics: 'metric_date', output_granularity: 'metric_date',
  }) }) }));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop'], time_semantics: 'current_snapshot', output_granularity: 'snapshot',
  }) }) }));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({
    required_variables: ['shop'], time_semantics: 'current_change_log', output_granularity: 'current_change_log',
  }) }) }));
});

test('binds owner scopes to business trees and stable ID placeholders', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ output_path_template: '广告户数据/API/{{time_file}}' }) }) }), code('report_output_template_owner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ output_path_template: '店铺数据/../广告户数据/API/{{time_file}}' }) }) }), code('report_output_template_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ output_path_template: '广告户数据/{{advertiser_id}}/官方/{{segment_file}}' }) }) }), code('report_output_template_owner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ output_path_template: '广告户数据/{{advertiser_name}}/官方/{{advertiser_id}}/{{segment_file}}' }) }) }), code('report_output_template_owner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ output_path_template: '广告户数据/prefix-{{advertiser_name}}__{{advertiser_id}}/官方/{{segment_file}}' }) }) }), code('report_output_template_owner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({
    owner_scope: 'campaign', required_variables: ['shop', 'advertiser', 'campaign', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit',
    output_path_template: '计划数据/{{advertiser_name}}__{{advertiser_id}}/{{campaign_id}}/报表/{{segment_file}}',
  }) }) }), code('report_output_template_owner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({
    owner_scope: 'product', required_variables: ['shop', 'advertiser', 'campaign', 'product', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit', product_selection: 'all_or_explicit',
    output_path_template: '计划数据/{{advertiser_name}}__{{advertiser_id}}/{{campaign_name}}__{{campaign_id}}/{{product_id}}/报表/{{segment_file}}',
  }) }) }), code('report_output_template_owner_invalid'));
});

test('requires the target-key file placeholder for each output granularity', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ output_path_template: '店铺数据/API/fixed.xlsx' }) }) }), code('report_output_template_key_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ output_path_template: '广告户数据/官方/{{time_file}}' }) }) }), code('report_output_template_key_invalid'));
});

test('rejects JSON output types and API tables without complete keys', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ success_output_type: 'generated_json' }) }) }), code('report_spec_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ headers: [] }) }) }), code('report_spec_api_table_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ required_key_columns: ['missing'] }) }) }), code('report_spec_api_table_invalid'));
});

test('allows empty providers only for disabled reports without a runner', (t) => {
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, {
    api: apiSpec({ enabled: false, runner: undefined, providers: {} }),
  }) }));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, {
    api: apiSpec({ runner: undefined, providers: {} }),
  }) }), code('report_providers_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, {
    api: apiSpec({ enabled: false, runner: 'scripts/routes/cross_border/api_report.js', providers: {} }),
  }) }), code('report_runner_invalid'));
});

test('real catalog derives enabled provider support and disabled reports from MD', () => {
  const loaded = loadReportMd();
  const specs = Object.values(loaded.specs);
  const enabled = specs.filter((item) => item.enabled);
  const disabled = specs.filter((item) => !item.enabled);
  assert.equal(specs.length, 23);
  assert.equal(enabled.length, 23);
  assert.equal(disabled.length, 0);
  assert.equal(enabled.reduce((total, spec) => total + Object.keys(spec.providers).length, 0), 46);
  for (const spec of enabled) {
    assert.equal(spec.runner, undefined, spec.report_id);
    assert.equal(Object.keys(spec.providers).length > 0, true, spec.report_id);
  }
  for (const reportId of DISABLED_REPORT_IDS) {
    const spec = loaded.specs[reportId];
    assert.equal(spec.enabled, false, reportId);
    assert.deepEqual(spec.providers, {}, reportId);
    assert.equal(spec.runner, undefined, reportId);
  }
});

test('validates v2 provider runners statically without executing them', (t) => {
  const crossRunner = 'scripts/routes/cross_border/api_report.js';
  const localRunner = 'scripts/routes/local/api_report.js';
  const makeV2 = (providers = {
    cross_border: { runner: crossRunner }, local: { runner: localRunner },
  }) => {
    const root = fixture(t, { api: apiSpec({ providers }) });
    for (const runner of [crossRunner, localRunner]) {
      fs.mkdirSync(path.dirname(path.join(root, ...runner.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(root, ...runner.split('/')), "throw new Error('provider_runner_must_not_execute');\n");
    }
    return root;
  };
  assert.doesNotThrow(() => loadReportMd({ skillRoot: makeV2() }));
  assert.throws(() => loadReportMd({ skillRoot: makeV2({ cross_border: { runner: '../outside.js' } }) }), code('report_provider_runner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: makeV2({ local: { runner: crossRunner } }) }), code('report_provider_runner_invalid'));
  const missing = makeV2(); fs.rmSync(path.join(missing, ...localRunner.split('/')));
  assert.throws(() => loadReportMd({ skillRoot: missing }), code('report_provider_runner_missing'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, {
    api: apiSpec({ runner: crossRunner, providers: { cross_border: { runner: crossRunner } } }),
  }) }), code('report_runner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: makeV2({ cross_border: {} }) }), code('report_provider_runner_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: makeV2({ cross_border: { adapter: crossRunner } }) }), code('report_provider_runner_invalid'));
});

test('validates optional unique safe output directories for API logical tables', (t) => {
  const logicalSpec = (logicalTables) => apiSpec({
    time_semantics: 'metric_date', output_granularity: 'metric_date',
    output_path_template: '店铺数据/API/{{time_file}}',
    headers: undefined, required_key_columns: undefined, logical_tables: logicalTables,
  });
  const table = (logicalTable, outputDirectory) => ({
    logical_table: logicalTable,
    ...(outputDirectory === undefined ? {} : { output_directory: outputDirectory }),
    headers: ['ID'], required_key_columns: ['ID'],
  });
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, {
    api: logicalSpec([table('total', '整体'), table('detail')]),
  }) }));
  for (const outputDirectory of ['', '../逃逸', '子目录/报表', 'CON', '报表 ']) {
    assert.throws(() => loadReportMd({ skillRoot: fixture(t, {
      api: logicalSpec([table('total', outputDirectory)]),
    }) }), code('report_spec_api_table_invalid'));
  }
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, {
    api: logicalSpec([table('total', 'detail'), table('detail')]),
  }) }), code('report_spec_api_table_invalid'));
});

test('rejects invalid not_applicable combinations and missing official validation', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ no_data_output_type: 'generated_csv' }) }) }), code('report_spec_no_data_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ no_data_rule: 'trusted_zero', no_data_output_type: null }) }) }), code('report_spec_no_data_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ official_validation: {} }) }) }), code('report_spec_official_validation_missing'));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec() }) }));
});

test('keeps no-data output generated for APIs and in the success format family', (t) => {
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ no_data_output_type: 'official_xlsx' }) }) }), code('report_spec_no_data_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { api: apiSpec({ no_data_output_type: 'generated_csv' }) }) }), code('report_spec_no_data_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ no_data_rule: 'trusted_zero', no_data_output_type: 'generated_xlsx' }) }) }), code('report_spec_no_data_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({ no_data_rule: 'trusted_zero', no_data_output_type: 'generated_csv' }) }) }), code('report_spec_official_no_data_headers_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({
    no_data_rule: 'trusted_zero', no_data_output_type: 'generated_csv', headers: ['ID', '值'], required_key_columns: [],
  }) }) }), code('report_spec_official_no_data_headers_invalid'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({
    no_data_rule: 'trusted_zero', no_data_output_type: 'generated_csv', headers: ['ID', '值'], required_key_columns: ['missing'],
  }) }) }), code('report_spec_official_no_data_headers_invalid'));
  assert.doesNotThrow(() => loadReportMd({ skillRoot: fixture(t, { official: officialSpec({
    no_data_rule: 'trusted_zero', no_data_output_type: 'generated_csv', headers: ['ID', '值'], required_key_columns: ['ID'],
  }) }) }));
});

test('rejects duplicate, missing, and unregistered specs', (t) => {
  const duplicate = `${specSection('api_report', apiSpec())}${specSection('api_duplicate', apiSpec())}${specSection('official_report', officialSpec())}`;
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: duplicate }) }), code('report_spec_duplicate'));
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: specSection('api_report', apiSpec()) }) }), code('report_section_missing'));
  const extra = `${specSection('api_report', apiSpec())}${specSection('official_report', officialSpec())}${specSection('extra_report', apiSpec({ report_id: 'extra_report' }))}`;
  assert.throws(() => loadReportMd({ skillRoot: fixture(t, { specText: extra }) }), code('report_spec_unknown_report'));
});

test('removed reports and aliases fail closed while orders remain registered', () => {
  const loaded = loadReportMd();
  for (const alias of [
    'shop_gmv_source_breakdown_daily', '店铺 GMV 来源拆解日报', 'scope:shop_gmv_source_breakdown',
    'gmvmax_campaign_upgrade_session_snapshot', 'GMV Max 升级会话快照', 'scope:gmvmax_upgrade_session',
    'gmvmax_campaign_product_creative_daily_performance', 'GMV Max 计划商品素材每日表现',
    'scope:gmvmax_campaign_product_creative_daily', 'GMV Max 计划商品素材每日专用',
  ]) assert.throws(() => resolveReportIds(alias, loaded), { code: 'report_alias_unknown' });
  const orders = loaded.specs.manage_orders_csv;
  assert.ok(orders);
  assert.equal(orders.report_id, 'manage_orders_csv');
  assert.deepEqual(Object.keys(orders.providers), ['cross_border', 'local']);
  for (const provider of Object.values(orders.providers)) assert.ok(provider.runner);
});
