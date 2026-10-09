'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { waitForCapture } = require('../../common/wait_for_capture');
const { writeWorkbook } = require('../../common/xlsx_writer');
const { sellerOrigin } = require('../common/inventory_snapshot');

const PROVIDER_ID = 'cross_border';
const REPORT_ID = 'fulfillment_performance_snapshot';

function validatedSellerId(input, failureCode) { const sellerId = String(input.shop?.seller_id || ''); if (!/^\d+$/u.test(sellerId)) fail(failureCode); return sellerId; }
function fail(code) { throw Object.assign(new Error(code), { code }); }
function validResponseOrigin(value) { try { return new URL(value).origin === value; } catch { return false; } }
function responseMatches(response, key, rules) { try { const url = new URL(response.url()); return url.origin === rules.response_origin && response.request().method() === rules.methods[key] && url.pathname === rules.response_paths[key]; } catch { return false; } }
function getPath(value, pathValue) { return (Array.isArray(pathValue) ? pathValue : [pathValue]).reduce((current, key) => current?.[key], value); }
function successful(items, rules) { const fields = rules.response_fields; return items.find((item) => getPath(item.body, fields.success_code) === 0 || getPath(item.body, fields.alternate_success_code) === 0); }
function hasSuccessfulResponses(found, rules) { return Boolean(successful(found.timeliness, rules) && successful(found.metrics, rules) && successful(found.suggestions, rules)); }
function statusLabel(value, rules) { return rules.row_contract.status_labels[String(Number(value))] || ''; }
function validMap(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length && Object.values(value).every((item) => typeof item === 'string' && item.trim()); }
function validateSpec(spec, providerSpec = spec?.providers?.[PROVIDER_ID], options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('fulfillment_report_spec_invalid'); }
  const rules = providerSpec?.api_contract; const paths = rules?.response_paths;
  if (spec?.report_id !== REPORT_ID || providerSpec !== spec?.providers?.[PROVIDER_ID] || !rules || !['timeliness', 'metrics', 'suggestions'].every((key) => typeof paths?.[key] === 'string' && paths[key].startsWith('/') && ['GET', 'POST'].includes(rules.methods?.[key]))
    || !validResponseOrigin(rules.response_origin)
    || typeof rules.entry_path !== 'string' || !rules.entry_path.startsWith('/') || typeof rules.seller_query !== 'string' || !rules.seller_query
    || !validMap(rules.timeliness_metric_labels) || !validMap(rules.performance_metric_labels) || !validMap(rules.suggestion_metric_labels)
    || !rules.response_fields || !rules.row_contract || !validMap(rules.row_contract.status_labels) || typeof rules.sheet_name !== 'string' || !rules.sheet_name
    || ![rules.navigation_timeout_ms, rules.capture_timeout_ms, rules.poll_interval_ms].every((value) => Number.isInteger(value) && value > 0)) fail('fulfillment_report_spec_invalid');
  return rules;
}
function rowsFor(headers, timeliness, metrics, suggestions, capturedAt, rules) {
  if (!Array.isArray(headers) || !headers.length) fail('fulfillment_report_headers_missing');
  const rows = [headers.slice()];
  const fields = rules.response_fields;
  const timeItems = [getPath(timeliness, fields.timeliness_sum), ...(getPath(timeliness, fields.timeliness_list) || [])];
  for (const item of timeItems) { const type = getPath(item, fields.timeliness_type); const period=getPath(timeliness,fields.timeliness_period); rows.push([capturedAt, '平均履约时间', rules.timeliness_metric_labels[type] || type || '', Number(getPath(item, fields.timeliness_value)), rules.row_contract.timeliness_unit, Number(getPath(item,fields.timeliness_diff)), Number(getPath(item,fields.timeliness_previous)), Number(getPath(item,fields.timeliness_industry_average)), getPath(item,fields.timeliness_industry_name) || '', '', '', getPath(timeliness, fields.timeliness_metric_date) || '', '', '', '', `官方${Number(period) === 1 ? '7天' : period}窗口`]); }
  for (const item of getPath(metrics, fields.metrics_list) || []) { const date = getPath(item,fields.metric_date_info) || {}; const type=getPath(item,fields.metric_type); rows.push([capturedAt, '履约表现指标', rules.performance_metric_labels[type] || type || '', Number(getPath(item,fields.metric_value)), rules.row_contract.performance_unit, '', '', '', '', getPath(date,fields.metric_start) || '', getPath(date,fields.metric_end) || '', getPath(date,fields.metric_date) || '', Number(getPath(item,fields.metric_numerator)), Number(getPath(item,fields.metric_denominator)), statusLabel(getPath(item,fields.metric_status), rules), getPath(date,fields.metric_assessment_by) || '']); }
  const dispatch = getPath(suggestions, fields.suggestions) || {};
  for (const [key, label] of Object.entries(rules.suggestion_metric_labels)) rows.push([capturedAt, '履约提醒', label, Number(dispatch[key]), rules.row_contract.suggestion_unit, '', '', '', '', '', '', '', '', '', '', '官方当前提醒数量']);
  return rows;
}

function validateSource(timeliness, metrics, suggestions, rules) {
  const fields = rules.response_fields;
  const timeItems = [getPath(timeliness, fields.timeliness_sum), ...(getPath(timeliness, fields.timeliness_list) || [])];
  const timeTypes = new Set(timeItems.map((item) => getPath(item, fields.timeliness_type)));
  const metricTypes = new Set((getPath(metrics, fields.metrics_list) || []).map((item) => getPath(item, fields.metric_type)));
  if (!Object.keys(rules.timeliness_metric_labels).every((type) => timeTypes.has(type))) fail('fulfillment_timeliness_incomplete');
  if (!Object.keys(rules.performance_metric_labels).every((type) => metricTypes.has(type))) fail('fulfillment_metrics_incomplete');
  const dispatch = getPath(suggestions, fields.suggestions);
  if (!Object.keys(rules.suggestion_metric_labels).every((key) => Number.isFinite(Number(dispatch?.[key])))) fail('fulfillment_suggestions_incomplete');
}

async function exportFulfillmentPerformanceSnapshot(input, dependencies = {}) {
  const reportSpec = input?.reportSpec; const rules = validateSpec(reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  const sellerId = validatedSellerId(input, 'fulfillment_identity_unavailable');
  const browser = dependencies.browser;
  if (!browser || typeof browser.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  const context = dependencies.browserContext;
  if (!context || typeof browser.contexts !== 'function' || !browser.contexts().includes(context)) fail('browser_context_missing');
  const capturedAt = (dependencies.clock || (() => new Date()))().toISOString();
  const page = context.pages().find((item) => item.url() === input.b.seller_page_url) || context.pages().find((item) => /^https:\/\/seller(?:-|\.)/.test(item.url()));
    if (!page) fail('seller_page_missing');
    const origin = sellerOrigin(input.b.seller_page_url);
    const found = { timeliness: [], metrics: [], suggestions: [] };
    const collect = async (response) => {
      try {
        const key = Object.keys(rules.response_paths).find((candidate) => responseMatches(response, candidate, rules));
        if (!key) return;
        found[key].push({ request_url: response.url(), body: await response.json() });
      } catch { /* required responses fail closed below */ }
    };
    page.on('response', collect);
    try {
      const targetUrl = new URL(rules.entry_path, origin);
      const currentUrl = new URL(page.url());
      const navigationOptions = { waitUntil: 'domcontentloaded', timeout: rules.navigation_timeout_ms };
      if (currentUrl.origin === targetUrl.origin && currentUrl.pathname === targetUrl.pathname) await page.reload(navigationOptions);
      else await page.goto(targetUrl.href, navigationOptions);
      await (dependencies.waitForCapture || waitForCapture)(page, () => hasSuccessfulResponses(found, rules), { timeoutMs: rules.capture_timeout_ms, pollMs: rules.poll_interval_ms });
    } finally { page.off('response', collect); }
    const timeliness = successful(found.timeliness, rules); const metrics = successful(found.metrics, rules); const suggestions = successful(found.suggestions, rules);
    if (!timeliness || !metrics || !suggestions) fail('fulfillment_source_unavailable');
    for (const response of [timeliness, metrics, suggestions]) if (String(new URL(response.request_url).searchParams.get(rules.seller_query)) !== sellerId) fail('fulfillment_identity_mismatch');
    validateSource(timeliness.body, metrics.body, suggestions.body, rules);
    const rows = rowsFor(reportSpec.headers, timeliness.body, metrics.body, suggestions.body, capturedAt, rules);
    fs.mkdirSync(input.outputDir, { recursive: true });
    const outputFile = path.join(input.outputDir, `履约表现诊断快照_${capturedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.xlsx`);
    writeWorkbook(outputFile, rows, { sheetName: rules.sheet_name });
    const buffer = fs.readFileSync(outputFile);
  return { schema_version: 'fulfillment_performance_snapshot_v1', status: 'success', provider_id: PROVIDER_ID, shop_alias: input.a.shop_alias, shop_id: sellerId, captured_at: capturedAt, date_semantics: 'snapshot', metric_date: getPath(timeliness.body, rules.response_fields.timeliness_metric_date), row_count: rows.length - 1, output_file: outputFile, generated_filename: path.basename(outputFile), generated_file: true, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), byte_length: buffer.length };
}

module.exports = { exportFulfillmentPerformanceSnapshot, hasSuccessfulResponses, rowsFor, run: exportFulfillmentPerformanceSnapshot, statusLabel, successful, validateSource, validateSpec };
