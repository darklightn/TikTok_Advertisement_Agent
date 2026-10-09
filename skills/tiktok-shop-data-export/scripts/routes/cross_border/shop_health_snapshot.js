'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { waitForCapture } = require('../../common/wait_for_capture');
const { writeWorkbook } = require('../../common/xlsx_writer');
const { sellerOrigin } = require('../common/inventory_snapshot');

const PROVIDER_ID = 'cross_border';
const REPORT_ID = 'shop_health_snapshot';
function validatedSellerId(input, failureCode) { const sellerId = String(input.shop?.seller_id || ''); if (!/^\d+$/u.test(sellerId)) fail(failureCode); return sellerId; }
function fail(code) { throw Object.assign(new Error(code), { code }); }
function validResponseOrigin(value) { try { return new URL(value).origin === value; } catch { return false; } }
function responseMatches(response, key, rules) { try { const url = new URL(response.url()); return url.origin === rules.response_origin && response.request().method() === rules.methods[key] && url.pathname === rules.response_paths[key]; } catch { return false; } }
function validateSpec(spec, providerSpec = spec?.providers?.[PROVIDER_ID], options = {}) { try { validateReportSpec(spec, options); } catch { fail('shop_health_report_spec_invalid'); } const rules = providerSpec?.api_contract; if (spec?.report_id !== REPORT_ID || providerSpec !== spec?.providers?.[PROVIDER_ID] || !rules || typeof rules.entry_path !== 'string' || !rules.entry_path.startsWith('/') || !['score', 'overview', 'metrics'].every((key) => typeof rules.response_paths?.[key] === 'string' && rules.response_paths[key].startsWith('/') && ['GET', 'POST'].includes(rules.methods?.[key])) || !validResponseOrigin(rules.response_origin) || typeof rules.seller_query !== 'string' || !rules.seller_query || !rules.response_fields || !rules.display_contract || rules.display_contract.missing_metric_value !== 'blank' || typeof rules.sheet_name !== 'string' || !rules.sheet_name || ![rules.navigation_timeout_ms, rules.capture_timeout_ms, rules.poll_interval_ms].every((value) => Number.isInteger(value) && value > 0)) fail('shop_health_report_spec_invalid'); return rules; }
function getPath(value, pathValue) { return (Array.isArray(pathValue) ? pathValue : [pathValue]).reduce((current, key) => current?.[key], value); }
function finiteNumber(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function positiveTimestamp(value) { return finiteNumber(value) && Number(value) > 0; }
function date(value) { return positiveTimestamp(value) ? new Date(Number(value) * 1000).toISOString().slice(0, 10) : ''; }
function operator(value, rules) { return rules.display_contract.operator_labels[String(value)] || ''; }
function display(value, unit, rules) { if (value == null) return ''; return Number(unit) === rules.display_contract.percentage_unit ? `${Number(value) * 100}%` : Number(value); }
function successful(items, rules) { return items.filter((item) => getPath(item.body, rules.response_fields.success_code) === 0); }

function validateScore(value) {
  if (!finiteNumber(value)) fail('shop_health_score_incomplete');
}
function validateOverview(value, rules) {
  const fields = rules.response_fields;
  if (!value || !finiteNumber(value[fields.overview_score]) || !positiveTimestamp(value[fields.overview_start])
    || !positiveTimestamp(value[fields.overview_end]) || !finiteNumber(value[fields.overview_unread])
    || Number(value[fields.overview_unread]) < 0) fail('shop_health_overview_incomplete');
}
function validateMetrics(groups, rules) {
  const fields = rules.response_fields;
  if (!Array.isArray(groups)) fail('shop_health_metrics_incomplete');
  for (const group of groups) {
    if (!group || !Array.isArray(group[fields.metrics])) fail('shop_health_metrics_incomplete');
    for (const metric of group[fields.metrics]) {
      const hasKeys = String(group[fields.group_key] || '').trim() && String(metric?.[fields.metric_key] || '').trim();
      const validValue = metric?.[fields.metric_value] == null || finiteNumber(metric[fields.metric_value]);
      const validTarget = metric?.[fields.metric_target] == null
        || (finiteNumber(metric[fields.metric_target]) && Boolean(operator(metric[fields.metric_operator], rules)));
      if (!hasKeys || !validValue || !finiteNumber(metric?.[fields.metric_unit])
        || !validTarget || !positiveTimestamp(metric?.[fields.metric_start]) || !positiveTimestamp(metric?.[fields.metric_end])
        || !finiteNumber(metric?.[fields.metric_violation_count]) || Number(metric[fields.metric_violation_count]) < 0) fail('shop_health_metrics_incomplete');
    }
  }
}

function rowsFor(headers, score, overview, groups, capturedAt, rules) {
  if (!Array.isArray(headers) || !headers.length) fail('shop_health_report_headers_missing');
  const rows = [headers.slice()];
  rows.push([capturedAt, '账号健康', '账号健康分', Number(score), '', '', '', '', 'TikTok Shop账号健康分']);
  const fields = rules.response_fields;
  rows.push([capturedAt, '违规概览', '违规分', Number(overview[fields.overview_score]), '', date(overview[fields.overview_start]), date(overview[fields.overview_end]), Number(overview[fields.overview_unread]), '']);
  for (const group of groups) {
    for (const metric of group[fields.metrics]) {
      rows.push([capturedAt, group[fields.group_key], metric[fields.metric_key], display(metric[fields.metric_value], metric[fields.metric_unit], rules), metric[fields.metric_target] == null ? '' : `${operator(metric[fields.metric_operator], rules)} ${display(metric[fields.metric_target], metric[fields.metric_unit], rules)}`, date(metric[fields.metric_start]), date(metric[fields.metric_end]), Number(metric[fields.metric_violation_count]), metric[fields.metric_tooltip] || '']);
    }
  }
  return rows;
}

async function exportShopHealthSnapshot(input, dependencies = {}) {
  const reportSpec = input?.reportSpec; const rules = validateSpec(reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  const sellerId = validatedSellerId(input, 'shop_health_identity_unavailable');
  const browser = dependencies.browser;
  if (!browser || typeof browser.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  const context = dependencies.browserContext;
  if (!context || typeof browser.contexts !== 'function' || !browser.contexts().includes(context)) fail('browser_context_missing');
  const capturedAt = (dependencies.clock || (() => new Date()))().toISOString();
  const page = context.pages().find((item) => item.url() === input.b.seller_page_url)
      || context?.pages().find((item) => /^https:\/\/seller(?:-|\.)/.test(item.url()));
    if (!page) fail('seller_page_missing');
    const origin = sellerOrigin(input.b.seller_page_url);
    const found = { score: [], overview: [], metrics: [] };
    const listener = async (response) => {
      try {
        const key = Object.keys(rules.response_paths).find((candidate) => responseMatches(response, candidate, rules));
        if (!key) return;
        found[key].push({ request_url: response.url(), body: await response.json() });
      } catch { /* required responses fail closed below */ }
    };
    page.on('response', listener);
    try {
      await page.goto(new URL(rules.entry_path, origin).href, { waitUntil: 'domcontentloaded', timeout: rules.navigation_timeout_ms });
      await (dependencies.waitForCapture || waitForCapture)(page, () => Object.values(found).every((items) => successful(items, rules).length > 0), { timeoutMs: rules.capture_timeout_ms, pollMs: rules.poll_interval_ms });
    } finally { page.off('response', listener); }
    const scoreResponses = successful(found.score, rules); const overviewResponses = successful(found.overview, rules); const metricsResponses = successful(found.metrics, rules);
    if (!scoreResponses.length || !overviewResponses.length || !metricsResponses.length) fail('shop_health_source_unavailable');
    for (const response of [...scoreResponses, ...overviewResponses, ...metricsResponses]) {
      if (String(new URL(response.request_url).searchParams.get(rules.seller_query)) !== sellerId) fail('shop_health_identity_mismatch');
    }
    for (const response of scoreResponses) validateScore(getPath(response.body, rules.response_fields.score));
    for (const response of overviewResponses) validateOverview(getPath(response.body, rules.response_fields.overview), rules);
    for (const response of metricsResponses) validateMetrics(getPath(response.body, rules.response_fields.metrics_groups), rules);
    const score = getPath(scoreResponses[0].body, rules.response_fields.score); const overview = getPath(overviewResponses[0].body, rules.response_fields.overview); const groups = getPath(metricsResponses[0].body, rules.response_fields.metrics_groups);
    const rows = rowsFor(reportSpec.headers, score, overview, groups, capturedAt, rules);
    if (rows.length < 3) fail('shop_health_incomplete');
    fs.mkdirSync(input.outputDir, { recursive: true });
    const stamp = capturedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const outputFile = path.join(input.outputDir, `店铺健康诊断快照_${stamp}.xlsx`);
    writeWorkbook(outputFile, rows, { sheetName: rules.sheet_name });
    const buffer = fs.readFileSync(outputFile);
  return { schema_version: 'shop_health_snapshot_v1', status: 'success', provider_id: PROVIDER_ID, shop_alias: input.a.shop_alias, shop_id: sellerId, captured_at: capturedAt, date_semantics: 'snapshot', row_count: rows.length - 1, output_file: outputFile, generated_filename: path.basename(outputFile), generated_file: true, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), byte_length: buffer.length };
}

module.exports = { date, display, exportShopHealthSnapshot, operator, rowsFor, run: exportShopHealthSnapshot, validateMetrics, validateOverview, validateScore, validateSpec };
