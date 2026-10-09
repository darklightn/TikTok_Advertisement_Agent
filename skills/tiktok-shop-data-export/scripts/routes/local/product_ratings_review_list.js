'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeCsv } = require('../../common/csv');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { countCsvDataRows } = require('../../common/official_download_rows');
const { assertExportControlReady } = require('../../common/official_ui_control');

const PROVIDER_ID = 'local';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function fieldPath(value) { return Array.isArray(value) && value.length > 0 && value.every(text); }
function endpoint(value) { return /^\/[a-z0-9_/-]+$/u.test(String(value || '')) && !value.includes('//') && !value.includes('..'); }
function httpsOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; } }
function getPath(value, fields) { return fields.reduce((current, field) => current?.[field], value); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function validDate(value) { const parsed = new Date(`${value}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || '')) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; }
function activePage(page, origin) { try { const url = new URL(page.url()); return url.origin === origin && !/(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }
function isResponse(response, origin, pathname, method) { try { const url = new URL(response.url()); return response.request().method() === method && url.origin === origin && url.pathname === pathname; } catch { return false; } }

function validateSpec(spec, providerSpec = spec?.providers?.[PROVIDER_ID], options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('ratings_report_spec_invalid'); }
  const rules = providerSpec?.official_validation;
  if (providerSpec !== spec?.providers?.[PROVIDER_ID] || spec?.report_id !== 'product_ratings_review_list'
    || spec.enabled !== true || spec.owner_scope !== 'shop'
    || JSON.stringify(spec.required_variables) !== JSON.stringify(['shop', 'start_date', 'end_date'])
    || spec.source_type !== 'official_download' || spec.success_output_type !== 'official_csv'
    || spec.no_data_output_type !== 'generated_csv' || spec.time_semantics !== 'requested_range'
    || spec.output_granularity !== 'request_range' || spec.no_data_rule !== 'official_review_filtered_total_zero'
    || !Array.isArray(spec.headers) || !spec.headers.length || !spec.headers.every(text)
    || !object(spec.generated_csv_validation) || !object(rules)
    || providerSpec.transport !== 'official_ui_job_download') fail('ratings_report_spec_invalid');
  if (!httpsOrigin(rules.seller_origin) || !httpsOrigin(rules.response_origin)
    || ![rules.entry_path, rules.list_endpoint, rules.start_endpoint, rules.job_endpoint].every(endpoint)
    || rules.list_method !== 'POST' || rules.start_method !== 'POST' || rules.job_method !== 'GET'
    || ![rules.date_trigger_placeholder, rules.date_panel_selector, rules.date_header_selector,
      rules.date_control_selector, rules.date_cell_selector, rules.export_button_name, rules.shop_region_query].every(text)
    || !object(rules.response_paths)
    || !['list_total', 'job_id', 'job_authorized', 'job_file_url'].every((key) => fieldPath(rules.response_paths[key]))
    || ![rules.date_panel_count, rules.previous_control_index, rules.next_control_index, rules.max_month_moves,
      rules.navigation_timeout_ms, rules.baseline_timeout_ms, rules.job_timeout_ms,
      rules.download_timeout_ms, rules.data_start_row].every((value) => Number.isInteger(value) && value > 0)
    || rules.date_panel_count !== 2 || rules.previous_control_index >= rules.next_control_index
    || rules.data_start_row !== 2 || providerSpec.retry_policy?.max_total_attempts !== 1
    || providerSpec.retry_policy?.identity_and_contract_failures_retryable !== false
    || spec.generated_csv_validation.bom !== 'required' || spec.generated_csv_validation.delimiter !== ',') {
    fail('ratings_report_spec_invalid');
  }
  return spec;
}

function bindInput(input, dependencies) {
  if (input?.shop?.provider_id !== PROVIDER_ID) fail('report_provider_unsupported');
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  if (!object(input.a) || !object(input.b) || !object(input.shop)
    || input.a.status !== 'ready' || input.b.status !== 'operable' || input.shop.status !== 'identified'
    || !text(input.a.shop_alias) || input.a.shop_alias !== input.b.requested_shop_alias || input.a.shop_alias !== input.shop.shop_alias
    || String(input.a.browser_id) !== String(input.b.browser_id) || String(input.a.browser_id) !== String(input.shop.browser_id)
    || input.a.cdp_url !== input.b.cdp_url || input.a.cdp_url !== input.shop.cdp_url || !digits(input.shop.seller_id)
    || String(input.a.seller_id || input.shop.seller_id) !== String(input.shop.seller_id)
    || !validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate
    || !dependencies.browser || !dependencies.browserContext) fail('ratings_input_invalid');
  const outputDir = path.resolve(String(input.outputDir || ''));
  if (!fs.statSync(outputDir, { throwIfNoEntry: false })?.isDirectory() || fs.readdirSync(outputDir).length) fail('output_directory_invalid');
  const rules = input.providerSpec.official_validation;
  let sellerUrl;
  try { sellerUrl = new URL(input.b.seller_page_url); } catch { fail('provider_binding_invalid'); }
  if (sellerUrl.origin !== rules.seller_origin) fail('provider_binding_invalid');
  const page = dependencies.browserContext.pages?.().find((candidate) => activePage(candidate, rules.seller_origin));
  if (!page) fail('seller_page_missing');
  const context = { browser: dependencies.browser, browserContext: dependencies.browserContext, page, outputDir, rules };
  assertSession(context);
  return context;
}

function assertSession(context) {
  if (!context.browser.isConnected?.()) fail('browser_disconnected');
  if (!context.browser.contexts?.().includes(context.browserContext)) fail('browser_context_missing');
  if (!context.browserContext.pages?.().includes(context.page)) fail('seller_page_missing');
  if (!activePage(context.page, context.rules.seller_origin)) fail('seller_origin_mismatch');
}

function monthKey(value) { const [year, month] = value.split('-').map(Number); return year * 12 + month - 1; }
function panelMonth(value) { const parts = String(value || '').match(/\d+/gu)?.map(Number) || []; const yearIndex = parts.findIndex((part) => part >= 2000); const month = parts[yearIndex === 0 ? 1 : 0]; if (parts.length < 2 || yearIndex < 0 || month < 1 || month > 12) fail('review_date_picker_contract_changed'); return parts[yearIndex] * 12 + month - 1; }
async function movePanel(panel, target, direction, rules) { for (let moves = 0; moves < rules.max_month_moves; moves += 1) { const current = panelMonth(await panel.locator(rules.date_header_selector).innerText()); if (current === target) return; if ((direction === 'previous' && current < target) || (direction === 'next' && current > target)) fail('review_date_picker_contract_changed'); await panel.locator(rules.date_control_selector).nth(direction === 'previous' ? rules.previous_control_index : rules.next_control_index).click(); } fail('review_date_picker_contract_changed'); }
async function clickDay(panel, date, rules) { const day = String(Number(date.slice(8, 10))).padStart(2, '0'); const cell = panel.locator(rules.date_cell_selector).filter({ hasText: new RegExp(`^${day}$`, 'u') }); if (await cell.count() !== 1) fail('review_date_picker_contract_changed'); await cell.click(); }

function listResponseMatches(response, rules) { return isResponse(response, rules.response_origin, rules.list_endpoint, rules.list_method); }

async function applyDateRange(page, startDate, endDate, rules) {
  await page.getByPlaceholder(rules.date_trigger_placeholder).click();
  const panels = page.locator(rules.date_panel_selector);
  if (await panels.count() !== rules.date_panel_count) fail('review_date_picker_contract_changed');
  const first = panels.first();
  await movePanel(first, monthKey(startDate), 'previous', rules);
  await clickDay(first, startDate, rules);
  const refreshed = page.locator(rules.date_panel_selector);
  const candidates = [refreshed.first(), refreshed.last()]; let endPanel = null;
  for (const candidate of candidates) if (panelMonth(await candidate.locator(rules.date_header_selector).innerText()) === monthKey(endDate)) endPanel = candidate;
  if (!endPanel) { endPanel = refreshed.last(); await movePanel(endPanel, monthKey(endDate), 'next', rules); }
  const pending = page.waitForResponse((response) => listResponseMatches(response, rules), { timeout: rules.navigation_timeout_ms });
  await clickDay(endPanel, endDate, rules);
  const response = await pending.catch((error) => {
    if (error?.name === 'TimeoutError') fail('review_list_response_not_observed');
    throw error;
  });
  const body = await response.json().catch(() => null); const total = getPath(body, rules.response_paths.list_total);
  if (response.status() !== 200 || body?.code !== 0 || !Number.isInteger(total) || total < 0) fail('review_list_contract_changed');
  return total;
}

async function parseJob(response, rules) {
  const body = await response.json().catch(() => null); const id = getPath(body, rules.response_paths.job_id);
  if (response.status() !== 200 || body?.code !== 0 || !Number.isInteger(id) || id < 0) fail('review_export_job_contract_changed');
  return body;
}

function normalizeOfficialUrl(fileUrl) {
  if (!text(fileUrl) || fileUrl !== fileUrl.trim() || /\s/u.test(fileUrl)) fail('review_export_file_invalid');
  let target;
  try {
    if (fileUrl.startsWith('https://')) target = new URL(fileUrl);
    else {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(fileUrl) || /^[\/\\]/u.test(fileUrl)) fail('review_export_file_invalid');
      target = new URL('https://' + fileUrl);
    }
  } catch (error) { if (error?.code) throw error; fail('review_export_file_invalid'); }
  const validHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(target.hostname);
  if (target.protocol !== 'https:' || target.username || target.password || !validHostname) fail('review_export_file_invalid');
  return target;
}

async function downloadOfficial(context, fileUrl) {
  const target = normalizeOfficialUrl(fileUrl);
  let response;
  try { response = await context.browserContext.request.get(target.href, { timeout: context.rules.download_timeout_ms, failOnStatusCode: false }); }
  catch { fail('review_export_download_failed'); }
  if ([401, 403].includes(response.status())) fail('transport_login_required');
  if (response.status() !== 200) fail('review_export_download_failed');
  let finalUrl; try { finalUrl = new URL(response.url()); } catch { fail('review_export_download_failed'); }
  if (finalUrl.protocol !== 'https:' || /(?:login|signin)(?:\/|$)/iu.test(finalUrl.pathname)) fail('transport_login_required');
  const headers = response.headers(); const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const buffer = await response.body();
  if (contentType.includes('text/html') || contentType.includes('application/json') || /^\s*</u.test(buffer.subarray(0, 256).toString('utf8'))) fail('transport_login_required');
  return buffer;
}

function identity(input) { return { shop_id: String(input.shop.seller_id), seller_id: String(input.shop.seller_id), oec_seller_id: String(input.shop.seller_id), provider_id: PROVIDER_ID }; }

async function run(input, dependencies = {}) {
  const context = bindInput(input, dependencies); const { page, rules, outputDir } = context; const spec = input.reportSpec;
  const entry = new URL(rules.entry_path, rules.seller_origin);
  let sellerPage; try { sellerPage = new URL(input.b.seller_page_url); } catch { fail('provider_binding_invalid'); }
  const region = sellerPage.searchParams.get(rules.shop_region_query); if (region) entry.searchParams.set(rules.shop_region_query, region);
  const baselinePending = page.waitForResponse((response) => isResponse(response, rules.response_origin, rules.job_endpoint, rules.job_method), { timeout: rules.baseline_timeout_ms });
  try { await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: rules.navigation_timeout_ms }); } catch (error) { void baselinePending.catch(() => {}); if (error?.name === 'TimeoutError') fail('review_page_navigation_timeout'); throw error; }
  const baselineResponse = await baselinePending.catch((error) => {
    if (error?.name === 'TimeoutError') fail('review_export_baseline_unavailable');
    throw error;
  });
  const baseline = await parseJob(baselineResponse, rules); assertSession(context);
  const observe = dependencies.applyDateRange || applyDateRange;
  const total = await observe(page, input.startDate, input.endDate, rules);
  if (!Number.isInteger(total) || total < 0) fail('review_list_contract_changed');
  if (total === 0) {
    const outputFile = path.join(outputDir, 'ratings_empty.csv');
    writeCsv(outputFile, [spec.headers], { bom: true }); const buffer = fs.readFileSync(outputFile);
    return { schema_version: 'product_ratings_review_list_v3', status: 'no_data', ...identity(input), start_date: input.startDate, end_date: input.endDate, output_file: outputFile, byte_length: buffer.length, sha256: sha256(buffer), generated_file: true, row_count: 0, no_data_evidence: spec.no_data_rule };
  }
  const baselineId = getPath(baseline, rules.response_paths.job_id);
  const button = page.getByRole('button', { name: rules.export_button_name, exact: true });
  await assertExportControlReady(button, 'ratings_export_control_not_ready');
  const startedPending = page.waitForResponse((response) => isResponse(response, rules.response_origin, rules.start_endpoint, rules.start_method), { timeout: rules.job_timeout_ms });
  await button.click();
  const startedResponse = await startedPending.catch((error) => {
    if (error?.name === 'TimeoutError') fail('review_export_start_failed');
    throw error;
  });
  const started = await startedResponse.json().catch(() => null);
  if (startedResponse.status() !== 200 || started?.code !== 0) fail('review_export_start_failed');
  const deadline = Date.now() + rules.job_timeout_ms; const jobs = new Map(); let accepted = null;
  while (Date.now() < deadline) {
    const response = await page.waitForResponse((item) => isResponse(item, rules.response_origin, rules.job_endpoint, rules.job_method), { timeout: Math.max(1, deadline - Date.now()) }).catch(() => null);
    if (!response) break; const job = await parseJob(response, rules); const id = getPath(job, rules.response_paths.job_id);
    if (id === baselineId) continue; if (id <= baselineId) fail('review_export_job_id_regressed');
    jobs.set(id, job); if (jobs.size > 1) fail('review_export_new_job_ambiguous'); accepted = job;
    if (getPath(job, rules.response_paths.job_authorized) === true && text(getPath(job, rules.response_paths.job_file_url))) break;
  }
  if (!accepted || getPath(accepted, rules.response_paths.job_authorized) !== true) fail('review_export_job_timeout');
  const fileUrl = getPath(accepted, rules.response_paths.job_file_url); if (!text(fileUrl)) fail('review_export_job_timeout');
  const buffer = await downloadOfficial(context, fileUrl); const dataRowCount = countCsvDataRows(buffer, rules.data_start_row);
  const hash = sha256(buffer); const taskId = String(getPath(accepted, rules.response_paths.job_id)); const outputFile = path.join(outputDir, `${taskId}.csv`);
  fs.writeFileSync(outputFile, buffer, { flag: 'wx' }); const saved = fs.readFileSync(outputFile);
  if (saved.length !== buffer.length || sha256(saved) !== hash) fail('official_file_changed'); assertSession(context);
  return { schema_version: 'product_ratings_review_list_v3', status: 'success', ...identity(input), start_date: input.startDate, end_date: input.endDate, task_id: taskId, output_file: outputFile, byte_length: saved.length, sha256: hash, official_file_unchanged: true, data_row_count: dataRowCount };
}

module.exports = { applyDateRange, listResponseMatches, normalizeOfficialUrl, run, validateSpec };
