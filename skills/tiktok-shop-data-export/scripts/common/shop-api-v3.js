'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('./canonical_json');
const { writeWorkbook } = require('./xlsx_writer');

function fail(code, details = {}) { throw Object.assign(new Error(code), { code, details }); }
function sellerId(input) {
  const value = String(input?.shop?.seller_id || '');
  if (!/^\d+$/u.test(value)) fail('shop_api_identity_unavailable');
  return value;
}
function sellerOrigin(input) {
  let origin;
  try { origin = new URL(input?.b?.seller_page_url).origin; } catch { fail('seller_origin_invalid'); }
  return origin;
}
function borrowedPage(input, dependencies) {
  const browser = dependencies.browser; const context = dependencies.browserContext;
  if (typeof browser?.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  if (!context || typeof context.pages !== 'function' || !browser.contexts().includes(context)) fail('browser_context_missing');
  const origin = sellerOrigin(input);
  const page = context.pages().find((item) => {
    try { const url = new URL(item.url()); return url.origin === origin && !/\/(?:login|passport)(?:\/|$)/iu.test(url.pathname); } catch { return false; }
  });
  if (!page) fail('seller_page_missing');
  return { browser, context, page, origin, sellerId: sellerId(input) };
}
async function requestJson(live, request, dependencies = {}) {
  const execute = dependencies.request || (async (_page, value) => {
    const response = await live.page.request.fetch(value.url, {
      method: value.method, headers: value.headers, params: value.search_params, data: value.body,
      timeout: value.timeout_ms || 30000, failOnStatusCode: false,
    });
    return { http_status: response.status(), body: await response.json().catch(() => null) };
  });
  if (!live.browser.isConnected()) fail('browser_disconnected');
  let result;
  try { result = await execute(live.page, request); } catch (error) {
    if (!live.browser.isConnected()) fail('browser_disconnected');
    throw error;
  }
  if (!live.browser.isConnected()) fail('browser_disconnected');
  return result;
}
function apiBody(result, code) {
  if (result?.http_status !== 200 || result.body?.code !== 0) fail(code);
  return result.body;
}
function json(value) { return canonicalize(value); }
function getPath(value, fields) { return fields.reduce((current, field) => current?.[field], value); }
function without(value, keys) {
  const output = { ...value };
  for (const key of keys) delete output[key];
  return output;
}
function writeArtifact(input, table, rows, status, extra = {}) {
  const outputDir = path.resolve(input.outputDir); fs.mkdirSync(outputDir, { recursive: true });
  const suffix = [extra.campaign_id, extra.product_id, extra.metric_date].filter((value) => value !== undefined).join('__');
  const outputFile = path.join(outputDir, `${table.logical_table}${suffix ? `__${suffix}` : ''}.xlsx`);
  const formats = input.reportSpec?.xlsx_column_formats || {};
  if (!formats || typeof formats !== 'object' || Array.isArray(formats)
    || Object.entries(formats).some(([header, format]) => !table.headers.includes(header) || format !== 'percentage')) fail('xlsx_column_formats_invalid');
  const percentageColumns = Object.keys(formats).map((header) => table.headers.indexOf(header));
  writeWorkbook(outputFile, [table.headers, ...rows], { percentageColumns });
  const bytes = fs.readFileSync(outputFile);
  return {
    status, logical_table: table.logical_table, output_file: outputFile,
    byte_length: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    generated_file: true, row_count: rows.length, ...extra,
  };
}
function aggregate(artifacts) {
  if (!artifacts.length || artifacts.every((item) => item.status === 'no_data')) return 'no_data';
  if (artifacts.some((item) => item.status === 'failed')) return artifacts.some((item) => item.status !== 'failed') ? 'partial' : 'failed';
  return 'success';
}

module.exports = { aggregate, apiBody, borrowedPage, fail, getPath, json, requestJson, sellerId, without, writeArtifact };
