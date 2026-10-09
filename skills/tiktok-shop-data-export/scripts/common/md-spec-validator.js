'use strict';

const fs = require('fs');
const path = require('path');
const { safeSegment } = require('./file-check');
const { validateCurrencyContract } = require('./currency-contract');

const OUTPUT_TYPES = new Set(['official_xlsx', 'official_csv', 'generated_xlsx', 'generated_csv']);
const SOURCE_TYPES = new Set(['official_download', 'official_api']);
const TIME_SEMANTICS = new Set(['requested_range', 'metric_date', 'current_snapshot', 'current_change_log']);
const OUTPUT_GRANULARITIES = new Set(['request_range', 'metric_date', 'snapshot', 'current_change_log', 'source_segment']);
const OWNER_VARIABLES = Object.freeze({
  shop: ['shop'],
  advertiser: ['shop', 'advertiser'],
  campaign: ['shop', 'advertiser', 'campaign'],
  product: ['shop', 'advertiser', 'campaign', 'product'],
});
const TIME_GRANULARITIES = Object.freeze({
  requested_range: new Set(['request_range', 'metric_date', 'source_segment']),
  metric_date: new Set(['metric_date']),
  current_snapshot: new Set(['snapshot']),
  current_change_log: new Set(['current_change_log']),
});
const OWNER_PATHS = Object.freeze({
  shop: { prefix: '店铺数据/', variables: [] },
  advertiser: { prefix: '广告户数据/', variables: [] },
  campaign: { prefix: '计划数据/', variables: [] },
  product: { prefix: '计划数据/', variables: [] },
});
const REQUIRED_VARIABLES = new Set(['shop', 'start_date', 'end_date', 'advertiser', 'campaign', 'product']);
const ALLOWED_PATH_VARIABLES = new Set([
  'shop_name', 'shop_id', 'advertiser_name', 'advertiser_id', 'campaign_name', 'campaign_id',
  'product_name', 'product_id', 'start_date', 'end_date', 'time_file', 'segment_file', 'logical_table',
]);

function fail(code, details = {}) { throw Object.assign(new Error(code), { code, details }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function uniqueText(values) {
  return Array.isArray(values) && values.length > 0
    && values.every(text) && new Set(values.map((value) => value.trim())).size === values.length;
}
function textList(values) { return Array.isArray(values) && values.length > 0 && values.every(text); }
function normalizedAlias(value) { return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(); }
function relativePath(value) {
  return text(value) && !value.includes('\\') && !path.posix.isAbsolute(value)
    && !/^[a-z]:/iu.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..');
}
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateReportRouter(value) {
  if (!object(value) || value.schema_version !== 'report_router_v1'
    || !Array.isArray(value.reports) || !value.reports.length || !Array.isArray(value.scopes)) fail('report_router_invalid');
  if (Object.keys(value).some((key) => !['schema_version', 'reports', 'scopes'].includes(key))) fail('report_router_invalid');
  const reportIds = new Set();
  const sections = new Set();
  const aliases = new Map();
  const register = (alias, kind, target) => {
    const normalized = normalizedAlias(alias);
    if (!normalized) fail('report_router_invalid');
    const existing = aliases.get(normalized);
    if (existing && (existing.kind !== kind || existing.target !== target)) fail('report_router_alias_ambiguous', { alias });
    if (existing) fail('report_router_alias_duplicate', { alias });
    aliases.set(normalized, { kind, target });
  };
  for (const report of value.reports) {
    if (!object(report) || Object.keys(report).some((key) => !['report_id', 'aliases', 'md', 'section'].includes(key))
      || !/^[a-z0-9_]+$/u.test(report.report_id || '') || reportIds.has(report.report_id)
      || !uniqueText(report.aliases) || !relativePath(report.md) || !/^[a-z0-9_]+$/u.test(report.section || '')) fail('report_router_invalid');
    const sectionKey = `${report.md}#${report.section}`;
    if (sections.has(sectionKey)) fail('report_router_invalid');
    sections.add(sectionKey);
    reportIds.add(report.report_id);
    for (const alias of report.aliases) register(alias, 'report', report.report_id);
  }
  for (const scope of value.scopes) {
    if (!object(scope) || Object.keys(scope).some((key) => !['aliases', 'report_ids'].includes(key))
      || !uniqueText(scope.aliases) || !uniqueText(scope.report_ids)) fail('report_router_invalid');
    for (const reportId of scope.report_ids) if (!reportIds.has(reportId)) fail('report_router_unknown_report', { report_id: reportId });
    const target = JSON.stringify(scope.report_ids);
    for (const alias of scope.aliases) register(alias, 'scope', target);
  }
  return value;
}

function validateRunner(spec, skillRoot) {
  if (spec.runner === undefined) return;
  fail('report_runner_invalid', { report_id: spec.report_id });
}

function validateOutputTemplate(spec) {
  if (!relativePath(spec.output_path_template)
    || !/^(?:店铺数据|广告户数据|计划数据)\//u.test(spec.output_path_template)) {
    fail('report_output_template_invalid', { report_id: spec.report_id });
  }
  const variables = [...spec.output_path_template.matchAll(/\{\{([a-z0-9_]+)\}\}/gu)].map((match) => match[1]);
  if (variables.some((variable) => !ALLOWED_PATH_VARIABLES.has(variable))) {
    fail('report_output_template_variable_invalid', { report_id: spec.report_id });
  }
  const withoutVariables = spec.output_path_template.replace(/\{\{[a-z0-9_]+\}\}/gu, 'value');
  if (withoutVariables.includes('{{') || withoutVariables.includes('}}')) fail('report_output_template_invalid', { report_id: spec.report_id });
  const outputRoot = path.resolve('.');
  const outputPath = path.resolve(...withoutVariables.split('/'));
  if (!inside(outputRoot, outputPath)) fail('report_output_template_invalid', { report_id: spec.report_id });
  const ownerPath = OWNER_PATHS[spec.owner_scope];
  const ownerRoot = path.resolve(...ownerPath.prefix.split('/').filter(Boolean));
  if (!spec.output_path_template.startsWith(ownerPath.prefix)
    || !inside(ownerRoot, outputPath)
    || ownerPath.variables.some((variable) => !variables.includes(variable))) {
    fail('report_output_template_owner_invalid', { report_id: spec.report_id });
  }
  if (spec.output_path_template.split('/').length !== 3) {
    fail('report_output_template_owner_invalid', { report_id: spec.report_id });
  }
  const keyVariable = spec.output_granularity === 'source_segment' ? 'segment_file' : 'time_file';
  if (!variables.includes(keyVariable)) fail('report_output_template_key_invalid', { report_id: spec.report_id });
}

function validateOwnerVariables(spec) {
  const ownerVariables = OWNER_VARIABLES[spec.owner_scope];
  if (!ownerVariables) fail('report_spec_owner_invalid', { report_id: spec.report_id });
  if (!uniqueText(spec.required_variables) || spec.required_variables.some((value) => !REQUIRED_VARIABLES.has(value))) {
    fail('report_spec_variables_invalid', { report_id: spec.report_id });
  }
  const needsCampaign = spec.required_variables.includes('campaign');
  if (needsCampaign && spec.campaign_selection !== 'all_or_explicit') {
    fail('report_spec_campaign_selection_invalid', { report_id: spec.report_id });
  }
  if (!needsCampaign && spec.campaign_selection !== undefined) {
    fail('report_spec_campaign_selection_invalid', { report_id: spec.report_id });
  }
  const needsProduct = spec.required_variables.includes('product');
  if (needsProduct && spec.product_selection !== 'all_or_explicit') {
    fail('report_spec_product_selection_invalid', { report_id: spec.report_id });
  }
  if (!needsProduct && spec.product_selection !== undefined) {
    fail('report_spec_product_selection_invalid', { report_id: spec.report_id });
  }
  if (ownerVariables.some((value) => !spec.required_variables.includes(value))) {
    fail('report_spec_variables_invalid', { report_id: spec.report_id });
  }
  const dependencies = {
    advertiser: ['shop'],
    campaign: ['shop', 'advertiser'],
    product: ['shop', 'advertiser', 'campaign'],
  };
  for (const [variable, required] of Object.entries(dependencies)) {
    if (spec.required_variables.includes(variable)
      && required.some((dependency) => !spec.required_variables.includes(dependency))) {
      fail('report_spec_variables_invalid', { report_id: spec.report_id });
    }
  }
}
function validateTimeAndGranularity(spec) {
  const hasStart = spec.required_variables.includes('start_date');
  const hasEnd = spec.required_variables.includes('end_date');
  const datesRequired = ['requested_range', 'metric_date'].includes(spec.time_semantics);
  if (hasStart !== hasEnd || hasStart !== datesRequired) fail('report_spec_time_variables_invalid', { report_id: spec.report_id });
  const incompatibleGranularity = !TIME_GRANULARITIES[spec.time_semantics].has(spec.output_granularity);
  const invalidSegmentSource = spec.output_granularity === 'source_segment' && spec.source_type !== 'official_download';
  if (incompatibleGranularity || invalidSegmentSource) {
    fail('report_spec_granularity_invalid', { report_id: spec.report_id });
  }
}
function formatFamily(outputType) { return outputType?.endsWith('_xlsx') ? 'xlsx' : outputType?.endsWith('_csv') ? 'csv' : null; }

function safeOutputDirectory(value) {
  if (!text(value)) return false;
  try { return safeSegment(value) === value; } catch { return false; }
}

function validateProviders(spec, skillRoot) {
  if (spec.runner !== undefined) fail('report_runner_invalid', { report_id: spec.report_id });
  if (spec.providers === undefined) fail('report_providers_invalid', { report_id: spec.report_id });
  if (!object(spec.providers) || Object.keys(spec.providers).some((key) => !['cross_border', 'local'].includes(key))) {
    fail('report_providers_invalid', { report_id: spec.report_id });
  }
  if (!Object.keys(spec.providers).length) {
    if (spec.enabled === false && spec.runner === undefined) return;
    fail('report_providers_invalid', { report_id: spec.report_id });
  }
  const providerRunners = new Set();
  for (const [providerId, provider] of Object.entries(spec.providers)) {
    if (!object(provider)) fail('report_providers_invalid', { report_id: spec.report_id, provider_id: providerId });
    if (provider.adapter !== undefined || !relativePath(provider.runner)) {
      fail('report_provider_runner_invalid', { report_id: spec.report_id, provider_id: providerId });
    }
    const expectedPrefix = `scripts/routes/${providerId}/`;
    if (!provider.runner.startsWith(expectedPrefix)) {
      fail('report_provider_runner_invalid', { report_id: spec.report_id, provider_id: providerId, runner: provider.runner });
    }
    const runner = path.resolve(skillRoot, ...provider.runner.split('/'));
    if (!inside(skillRoot, runner) || !fs.statSync(runner, { throwIfNoEntry: false })?.isFile()) {
      fail('report_provider_runner_missing', { report_id: spec.report_id, provider_id: providerId, runner: provider.runner });
    }
    if (providerRunners.has(runner)) fail('report_provider_runner_invalid', { report_id: spec.report_id, provider_id: providerId });
    providerRunners.add(runner);
  }
}

function validateApiTables(value) {
  if (value.logical_tables === undefined) {
    return uniqueText(value.headers) && uniqueText(value.required_key_columns)
      && value.required_key_columns.every((column) => value.headers.includes(column));
  }
  if (value.headers !== undefined || value.required_key_columns !== undefined
    || !Array.isArray(value.logical_tables) || !value.logical_tables.length) return false;
  const names = new Set();
  const outputDirectories = new Set();
  for (const table of value.logical_tables) {
    if (!object(table) || Object.keys(table).some((key) => !['logical_table', 'output_directory', 'headers', 'required_key_columns'].includes(key))
      || !/^[a-z0-9_]+$/u.test(table.logical_table || '') || names.has(table.logical_table)
      || (table.output_directory !== undefined && !safeOutputDirectory(table.output_directory))
      || !uniqueText(table.headers) || !uniqueText(table.required_key_columns)
      || table.required_key_columns.some((column) => !table.headers.includes(column))) return false;
    const outputDirectory = table.output_directory || table.logical_table;
    if (outputDirectories.has(outputDirectory)) return false;
    names.add(table.logical_table);
    outputDirectories.add(outputDirectory);
  }
  return true;
}

function validateReportSpec(value, options = {}) {
  const skillRoot = path.resolve(options.skillRoot || path.resolve(__dirname, '..', '..'));
  if (!object(value) || value.schema_version !== 'report_spec_v1' || !/^[a-z0-9_]+$/u.test(value.report_id || '')
    || typeof value.enabled !== 'boolean' || typeof value.explicit_only !== 'boolean'
    || !SOURCE_TYPES.has(value.source_type)
    || !OUTPUT_TYPES.has(value.success_output_type) || !TIME_SEMANTICS.has(value.time_semantics)
    || !OUTPUT_GRANULARITIES.has(value.output_granularity) || !text(value.no_data_rule)) fail('report_spec_invalid');
  if (value.no_data_rule === 'not_applicable') {
    if (value.no_data_output_type !== null) fail('report_spec_no_data_invalid', { report_id: value.report_id });
  } else if (!OUTPUT_TYPES.has(value.no_data_output_type)) fail('report_spec_no_data_invalid', { report_id: value.report_id });
  if (value.no_data_output_type !== null && formatFamily(value.success_output_type) !== formatFamily(value.no_data_output_type)) {
    fail('report_spec_no_data_invalid', { report_id: value.report_id });
  }
  if (value.single_day_time_file !== undefined
    && (typeof value.single_day_time_file !== 'boolean' || value.output_granularity !== 'request_range')) {
    fail('report_spec_granularity_invalid', { report_id: value.report_id });
  }
  if (value.published_identity_columns !== undefined
    && (value.success_output_type !== 'official_xlsx' || !uniqueText(value.published_identity_columns)
      || value.published_identity_columns.some((column) => !/^[a-z][a-z0-9_]*$/u.test(column)))) {
    fail('report_spec_published_identity_columns_invalid', { report_id: value.report_id });
  }
  if (value.source_type === 'official_api' && value.no_data_output_type !== null
    && !['generated_xlsx', 'generated_csv'].includes(value.no_data_output_type)) {
    fail('report_spec_no_data_invalid', { report_id: value.report_id });
  }
  if (value.source_type === 'official_api') {
    if (!['generated_xlsx', 'generated_csv'].includes(value.success_output_type)
      || !validateApiTables(value)) fail('report_spec_api_table_invalid', { report_id: value.report_id });
  } else {
    const providerOfficialValidation = !value.runner && object(value.providers)
      && Object.values(value.providers).length > 0
      && Object.values(value.providers).every((provider) => object(provider?.official_validation)
        && Object.keys(provider.official_validation).length > 0);
    if (!['official_xlsx', 'official_csv'].includes(value.success_output_type)
      || ((!text(value.official_validation) && !object(value.official_validation)) && !providerOfficialValidation)) fail('report_spec_official_validation_missing', { report_id: value.report_id });
    if (object(value.official_validation) && Object.keys(value.official_validation).length === 0) fail('report_spec_official_validation_missing', { report_id: value.report_id });
    if (['generated_xlsx', 'generated_csv'].includes(value.no_data_output_type)
      && (!textList(value.headers) || !uniqueText(value.required_key_columns)
        || value.required_key_columns.some((column) => !value.headers.includes(column)))) {
      fail('report_spec_official_no_data_headers_invalid', { report_id: value.report_id });
    }
  }
  validateOwnerVariables(value);
  validateTimeAndGranularity(value);
  if (value.currency_contract !== undefined) {
    try { validateCurrencyContract(value.currency_contract); }
    catch { fail('report_currency_contract_invalid', { report_id: value.report_id }); }
  }
  validateRunner(value, skillRoot);
  validateProviders(value, skillRoot);
  validateOutputTemplate(value);
  return value;
}

module.exports = {
  ALLOWED_PATH_VARIABLES,
  OUTPUT_GRANULARITIES,
  OUTPUT_TYPES,
  OWNER_VARIABLES,
  REQUIRED_VARIABLES,
  SOURCE_TYPES,
  TIME_SEMANTICS,
  inside,
  normalizedAlias,
  validateReportRouter,
  validateReportSpec,
};
