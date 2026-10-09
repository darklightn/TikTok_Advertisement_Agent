'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { captureProductListCurrency } = require('../../common/currency-contract');
const { countXlsxDataRows } = require('../../common/official_download_rows');
const { assertExportControlReady, resolveExportControl } = require('../../common/official_ui_control');
const { writeWorkbook } = require('../../common/xlsx_writer');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function pathValue(value, parts) { return parts.reduce((current, part) => current?.[part], value); }
function validPath(parts) { return Array.isArray(parts) && parts.length && parts.every((part) => /^[a-z0-9_]+$/u.test(part)); }
function validDate(value) { const parsed = new Date(`${value}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || '')) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === value; }
function nextDate(value) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0,10); }
function activePage(page, origin) { try { const url = new URL(page.url()); return url.origin === origin && !/(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function assertFailureSession(input, dependencies) {
  if (!dependencies.browser?.isConnected?.()) fail('browser_disconnected');
  if (!dependencies.browserContext || !dependencies.browser.contexts?.().includes(dependencies.browserContext)) fail('browser_context_missing');
  let origin; try { origin = new URL(input?.b?.seller_page_url).origin; } catch { return; }
  const pages = dependencies.browserContext.pages?.() || [];
  if (pages.some((page) => activePage(page, origin))) return;
  if (pages.some((page) => { try { const url = new URL(page.url()); return url.origin === origin && /(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } })) fail('seller_login_page');
  fail('seller_origin_mismatch');
}

function validateSpec(spec, providerSpec, options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('product_analytics_report_spec_invalid'); }
  const rules = providerSpec?.official_validation; const retry = providerSpec?.retry_policy;
  if (spec?.report_id !== 'product_analytics_performance' || spec.no_data_rule !== 'official_product_list_total_zero'
    || spec.providers?.local !== providerSpec || providerSpec?.transport !== 'official_ui_download' || !object(rules) || !object(retry)) fail('product_analytics_report_spec_invalid');
  let responseOrigin; try { responseOrigin = new URL(providerSpec.response_origin); } catch { fail('product_analytics_report_spec_invalid'); }
  if (responseOrigin.protocol !== 'https:' || responseOrigin.origin !== providerSpec.response_origin
    || !/^\/[a-z0-9_/-]+$/u.test(rules.entry_path) || !/^\/[a-z0-9_/-]+$/u.test(rules.list_endpoint)
    || rules.list_method !== 'POST' || !Array.isArray(rules.seller_queries) || rules.seller_queries.length !== 2
    || rules.seller_queries.some((value) => !text(value)) || new Set(rules.seller_queries).size !== 2
    || rules.request_end !== 'exclusive_next_day' || !text(rules.export_locator)
    || !Number.isInteger(rules.data_start_row) || rules.data_start_row < 1
    || !object(rules.entry_query) || !['range','shortcut','shortcut_value'].every((key) => text(rules.entry_query[key]))
    || !validPath(rules.list_total_path) || !validPath(rules.list_pagination_path)
    || !Number.isInteger(rules.request_timeout_ms) || rules.request_timeout_ms < 1
    || !Number.isInteger(rules.download_timeout_ms) || rules.download_timeout_ms < 1
    || retry.operation_class !== 'official_export_action' || retry.max_total_attempts !== 1
    || retry.identity_and_contract_failures_retryable !== false) fail('product_analytics_report_spec_invalid');
  return spec;
}

function assertSession(context) {
  if (!context.browser?.isConnected?.()) fail('browser_disconnected');
  if (!context.browserContext || !context.browser.contexts().includes(context.browserContext)) fail('browser_context_missing');
  if (!context.browserContext.pages().includes(context.page)) fail('seller_page_missing');
  if (!activePage(context.page, context.origin)) fail('seller_origin_mismatch');
}

function validateInput(input, dependencies) {
  if (input?.shop?.provider_id !== 'local') fail('report_provider_unsupported');
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot:dependencies.skillRoot });
  if (!object(input.a) || !object(input.b) || !object(input.shop) || !/^\d+$/u.test(String(input.shop.seller_id || ''))
    || !dependencies?.browser || !dependencies.browserContext || !validDate(input.startDate) || !validDate(input.endDate)
    || input.startDate > input.endDate) fail('product_analytics_input_invalid');
  const outputDir = path.resolve(String(input.outputDir || ''));
  if (!fs.statSync(outputDir, { throwIfNoEntry:false })?.isDirectory() || fs.readdirSync(outputDir).length) fail('output_directory_invalid');
  let sellerUrl; try { sellerUrl = new URL(input.b.seller_page_url); } catch { fail('provider_binding_invalid'); }
  if (sellerUrl.origin !== input.providerSpec.response_origin) fail('provider_binding_invalid');
  const page = dependencies.browserContext.pages().find((candidate) => activePage(candidate, sellerUrl.origin)); if (!page) fail('seller_page_missing');
  const context = { browser:dependencies.browser, browserContext:dependencies.browserContext, page, origin:sellerUrl.origin, outputDir }; assertSession(context); return context;
}

async function runInner(input, dependencies = {}) {
  const context = validateInput(input, dependencies); const spec = input.reportSpec; const rules = input.providerSpec.official_validation;
  const reportUrl = new URL(rules.entry_path, context.origin); reportUrl.searchParams.set(rules.entry_query.range, `${input.startDate}|${nextDate(input.endDate)}`); reportUrl.searchParams.set(rules.entry_query.shortcut, rules.entry_query.shortcut_value);
  const probePromise = context.page.waitForResponse((response) => { try { const url = new URL(response.url()); return response.request().method() === rules.list_method && url.origin === input.providerSpec.response_origin && url.pathname === rules.list_endpoint; } catch { return false; } }, { timeout:rules.request_timeout_ms });
  await context.page.goto(reportUrl.href, { waitUntil:'domcontentloaded', timeout:rules.request_timeout_ms }); assertSession(context);
  const response = await probePromise; const body = await response.json().catch(() => null); assertSession(context);
  const responseUrl = new URL(response.url()); const total = pathValue(body, rules.list_total_path); const pagination = pathValue(body, rules.list_pagination_path);
  if (response.status() !== 200 || body?.code !== 0 || responseUrl.origin !== input.providerSpec.response_origin || responseUrl.pathname !== rules.list_endpoint
    || rules.seller_queries.some((name) => responseUrl.searchParams.get(name) !== String(input.shop.seller_id))
    || !Number.isInteger(total) || total < 0 || !object(pagination)) fail('product_list_contract_changed');
  const identity = { shop_id:String(input.shop.seller_id), seller_id:String(input.shop.seller_id), oec_seller_id:String(input.shop.seller_id), provider_id:'local' };
  if (total === 0) {
    const currencyEvidence = await captureProductListCurrency(body, context.page, spec.currency_contract, dependencies);
    const outputFile = path.join(context.outputDir, 'product_analytics_empty.xlsx'); writeWorkbook(outputFile, [spec.headers]); const buffer = fs.readFileSync(outputFile);
    return { schema_version:'product_analytics_performance_v3', status:'no_data', ...identity, output_file:outputFile, byte_length:buffer.length, sha256:sha256(buffer), generated_file:true, row_count:0, no_data_evidence:spec.no_data_rule, currency_evidence:currencyEvidence };
  }
  const button = await resolveExportControl(context.page, rules.export_locator, 'product_analytics_export_control_not_ready', rules.request_timeout_ms); await assertExportControlReady(button, 'product_analytics_export_control_not_ready');
  const pending = context.page.waitForEvent('download', { timeout:rules.download_timeout_ms }); await button.click(); const download = await pending; assertSession(context);
  const stream = await download.createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk); const buffer = Buffer.concat(chunks);
  const dataRowCount = countXlsxDataRows(buffer, rules.data_start_row); const hash = sha256(buffer); const outputFile = path.join(context.outputDir, 'official_download.xlsx');
  fs.writeFileSync(outputFile, buffer, { flag:'wx' }); if (sha256(fs.readFileSync(outputFile)) !== hash) fail('official_file_changed');
  const currencyEvidence = await captureProductListCurrency(body, context.page, spec.currency_contract, dependencies);
  return { schema_version:'product_analytics_performance_v3', status:'success', ...identity, output_file:outputFile, byte_length:buffer.length, sha256:hash, official_file_unchanged:true, data_row_count:dataRowCount, currency_evidence:currencyEvidence };
}

async function run(input, dependencies = {}) { try { return await runInner(input, dependencies); } catch (error) { if (dependencies.browser) assertFailureSession(input, dependencies); throw error; } }

module.exports = { run, validateSpec };
