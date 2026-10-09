'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { countXlsxDataRows } = require('../../common/official_download_rows');
const { writeWorkbook } = require('../../common/xlsx_writer');
const { validateReportSpec } = require('../../common/md-spec-validator');

const PROVIDER_ID = 'local';

function fail(code, diagnostics) { throw Object.assign(new Error(code), { code }, diagnostics ? { diagnostics } : {}); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function uniqueText(values) {
  return Array.isArray(values) && values.length > 0 && values.every(text)
    && new Set(values).size === values.length;
}
function fieldPath(value) {
  return Array.isArray(value) && value.length > 0 && value.every((part) => /^[a-z0-9_]+$/u.test(part));
}
function endpoint(value) {
  return /^\/[a-z0-9_/-]+$/u.test(String(value || '')) && !value.includes('//') && !value.includes('..');
}
function exactHttpsOrigin(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && parsed.origin === value; } catch { return false; }
}
function getPath(value, parts) { return parts.reduce((current, part) => current?.[part], value); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function isActiveSellerPage(page, origin) {
  try {
    const value = new URL(page.url());
    return value.origin === origin && !/\/(?:account\/)?(?:login|signin)(?:\/|$)/iu.test(value.pathname);
  } catch { return false; }
}

function validateSpec(spec, providerSpec = spec?.providers?.[PROVIDER_ID], options = {}) {
  const rules = providerSpec?.official_validation;
  let invalidOuter = false;
  try { validateReportSpec(spec, options); } catch { invalidOuter = true; }
  invalidOuter ||= providerSpec !== spec?.providers?.[PROVIDER_ID]
    || spec?.report_id !== 'shop_creative_hub_video'
    || JSON.stringify(spec?.required_variables) !== JSON.stringify(['shop', 'advertiser', 'start_date', 'end_date'])
    || spec?.source_type !== 'official_download' || spec?.success_output_type !== 'official_xlsx'
    || spec?.no_data_output_type !== 'generated_xlsx' || spec?.time_semantics !== 'requested_range'
    || spec?.output_granularity !== 'request_range' || spec?.no_data_rule !== 'official_api_total_zero'
    || !text(spec?.output_path_template) || !uniqueText(spec?.headers) || !uniqueText(spec?.required_key_columns)
    || spec.required_key_columns.some((key) => !spec.headers.includes(key));
  if (invalidOuter || !object(rules)) fail('creative_report_spec_invalid');
  if (!exactHttpsOrigin(rules.response_origin) || !endpoint(rules.probe_endpoint) || !endpoint(rules.create_endpoint)
    || !endpoint(rules.task_query_endpoint) || !/^[a-z0-9_]+$/u.test(rules.scene || '')
    || rules.task_scene_response_policy !== 'optional_match') fail('creative_report_spec_invalid');
  const queryParameters = rules.query_parameters;
  const queryParameterValues = ['seller_id', 'advertiser_id', 'business_center_id', 'locale', 'language']
    .map((key) => queryParameters?.[key]);
  if (!object(queryParameters) || !uniqueText(queryParameterValues)
    || queryParameterValues.some((value) => !/^[a-z0-9_]+$/u.test(value))) fail('creative_report_spec_invalid');
  if (!object(rules.query_constants)
    || !text(rules.query_constants.locale) || !text(rules.query_constants.language)) fail('creative_report_spec_invalid');
  const requestFields = ['common_request', 'task_scene', 'task_id'].map((key) => rules.request_fields?.[key]);
  if (!object(rules.request_fields) || !uniqueText(requestFields)
    || requestFields.some((value) => !/^[a-z0-9_]+$/u.test(value))) fail('creative_report_spec_invalid');
  const common = rules.common_request;
  const validFilters = Array.isArray(common?.filters) && common.filters.length > 0
    && common.filters.every((filter) => object(filter)
      && text(filter.field) && Number.isInteger(filter.filter_type) && uniqueText(filter.in_field_values));
  if (!object(common) || !Number.isInteger(common.page) || common.page < 1
    || !Number.isInteger(common.probe_page_size) || common.probe_page_size < 1
    || !Number.isInteger(common.create_page_size) || common.create_page_size >= 0
    || !text(common.sort_stat) || !Number.isInteger(common.sort_order) || !validFilters
    || !uniqueText(common.dimensions) || !uniqueText(common.metrics)
    || !text(common.start_date_field) || !text(common.end_date_field)
    || common.start_date_field === common.end_date_field) fail('creative_report_spec_invalid');
  if (!object(rules.create_action)
    || !text(rules.create_action.field) || !text(rules.create_action.value)) fail('creative_report_spec_invalid');
  const responsePaths = ['probe_total', 'create_task_id', 'task_list', 'task_id', 'task_scene', 'task_status', 'task_url']
    .map((key) => rules.response_paths?.[key]);
  if (!object(rules.response_paths) || responsePaths.some((value) => !fieldPath(value))) fail('creative_report_spec_invalid');
  const statuses = rules.task_statuses;
  if (!object(statuses) || !uniqueText(statuses.pending) || !uniqueText(statuses.success) || !uniqueText(statuses.failed)
    || new Set([...statuses.pending, ...statuses.success, ...statuses.failed]).size
      !== statuses.pending.length + statuses.success.length + statuses.failed.length) fail('creative_report_spec_invalid');
  if (!Number.isInteger(rules.poll_interval_ms) || rules.poll_interval_ms < 0
    || !Number.isInteger(rules.max_polls) || rules.max_polls < 1
    || !Number.isInteger(rules.request_timeout_ms) || rules.request_timeout_ms < 1
    || !Number.isInteger(rules.download_timeout_ms) || rules.download_timeout_ms < 1
    || !Number.isInteger(rules.data_start_row) || rules.data_start_row < 1) fail('creative_report_spec_invalid');
  return spec;
}

function validateInput(input, dependencies) {
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  if (!object(input.a) || !object(input.b) || !object(input.shop)
    || !digits(input.shop.seller_id) || String(input.shop.seller_id) !== String(input.a?.seller_id || input.shop.seller_id)
    || !digits(input.advertiserId) || !digits(input.businessCenterId)
    || input.shop.provider_id !== PROVIDER_ID || !dependencies?.browser || !dependencies.browserContext
    || !validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate) {
    fail('creative_input_invalid');
  }
  const outputDir = path.resolve(String(input.outputDir || ''));
  if (!fs.statSync(outputDir, { throwIfNoEntry: false })?.isDirectory() || fs.readdirSync(outputDir).length) {
    fail('output_directory_invalid');
  }
  const expectedOrigin = input.providerSpec.official_validation.response_origin;
  let sellerOrigin;
  try { sellerOrigin = new URL(input.b.seller_page_url).origin; } catch { fail('provider_binding_invalid'); }
  if (expectedOrigin !== sellerOrigin) fail('provider_binding_invalid');
  const pages = dependencies.browserContext.pages?.() || [];
  const page = pages.find((candidate) => isActiveSellerPage(candidate, expectedOrigin));
  if (!page?.request || typeof page.request.fetch !== 'function') fail('seller_page_missing');
  return { outputDir, page, sellerOrigin: expectedOrigin };
}

function commonRequest(rules, startDate, endDate, pageSize) {
  const common = rules.common_request;
  return {
    [common.start_date_field]: startDate,
    [common.end_date_field]: endDate,
    page: common.page,
    page_size: pageSize,
    sort_stat: common.sort_stat,
    sort_order: common.sort_order,
    filters: common.filters.map((filter) => ({ ...filter, in_field_values: [...filter.in_field_values] })),
    dimensions: [...common.dimensions],
    metrics: [...common.metrics],
  };
}

function requestUrl(origin, endpointPath, rules, input) {
  const value = new URL(endpointPath, origin);
  const parameters = rules.query_parameters;
  value.searchParams.set(parameters.seller_id, String(input.shop.seller_id));
  value.searchParams.set(parameters.advertiser_id, String(input.advertiserId));
  value.searchParams.set(parameters.business_center_id, String(input.businessCenterId));
  value.searchParams.set(parameters.locale, rules.query_constants.locale);
  value.searchParams.set(parameters.language, rules.query_constants.language);
  return value;
}

function responseStatus(response) { return typeof response?.status === 'function' ? response.status() : response?.status; }
function responseUrl(response) { return typeof response?.url === 'function' ? response.url() : response?.url; }
function responseHeaders(response) { return typeof response?.headers === 'function' ? response.headers() : (response?.headers || {}); }
async function responseBuffer(response) {
  if (typeof response?.body === 'function') return response.body();
  if (Buffer.isBuffer(response?.body)) return response.body;
  fail('transport_response_invalid');
}

async function postJson(page, target, body, timeout, failureCode) {
  let response;
  try {
    response = await page.request.fetch(target.href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, data: body,
      timeout, failOnStatusCode: false,
    });
  } catch { fail(failureCode); }
  if (responseStatus(response) !== 200) fail(failureCode);
  let final;
  try { final = new URL(responseUrl(response)); } catch { fail(failureCode); }
  if (final.origin !== target.origin || final.pathname !== target.pathname) fail(failureCode);
  for (const [key, value] of target.searchParams) if (final.searchParams.get(key) !== value) fail(failureCode);
  let parsed;
  try { parsed = JSON.parse((await responseBuffer(response)).toString('utf8')); } catch { fail(failureCode); }
  if (!object(parsed) || parsed.code !== 0) fail(failureCode);
  return parsed;
}

function inspectWorkbook(buffer, spec) {
  return countXlsxDataRows(buffer, spec.official_validation.data_start_row);
}

function taskCandidates(body, paths) {
  const list = getPath(body, paths.task_list);
  return Array.isArray(list) ? list.filter(object) : [];
}

async function downloadOfficial(context, signedUrl, timeout) {
  let target;
  try { target = new URL(signedUrl); } catch { fail('official_download_url_invalid'); }
  if (target.protocol !== 'https:') fail('official_download_url_invalid');
  let response;
  try { response = await context.request.get(target.href, { timeout, failOnStatusCode: false }); }
  catch { fail('official_download_failed'); }
  const status = responseStatus(response);
  if (status === 401 || status === 403) fail('transport_login_required');
  if (status !== 200) fail('official_download_failed');
  let finalUrl;
  try { finalUrl = new URL(responseUrl(response)); } catch { fail('official_download_failed'); }
  if (/\/(?:login|signin)(?:\/|$)/iu.test(finalUrl.pathname)) fail('transport_login_required');
  const headers = responseHeaders(response);
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const buffer = await responseBuffer(response);
  if (contentType.includes('text/html') || /^\s*</u.test(buffer.subarray(0, 256).toString('utf8'))) fail('transport_login_required');
  return { buffer };
}

function resultIdentity(input) {
  return {
    shop_id: String(input.shop.seller_id), seller_id: String(input.shop.seller_id),
    oec_seller_id: String(input.shop.seller_id), advertiser_id: String(input.advertiserId),
    business_center_id: String(input.businessCenterId), provider_id: PROVIDER_ID,
  };
}

async function run(input, dependencies = {}) {
  const { outputDir, page, sellerOrigin } = validateInput(input, dependencies);
    const rules = input.providerSpec.official_validation; const spec = { ...input.reportSpec, official_validation: rules };
  const target = requestUrl(sellerOrigin, rules.probe_endpoint, rules, input);
  const probe = await postJson(page, target, {
    [rules.request_fields.common_request]: commonRequest(rules, input.startDate, input.endDate, rules.common_request.probe_page_size),
  }, rules.request_timeout_ms, 'creative_probe_failed');
  const total = getPath(probe, rules.response_paths.probe_total);
  if (!Number.isInteger(total) || total < 0) fail('creative_probe_contract_invalid');
  if (total === 0) {
    const outputFile = path.join(outputDir, 'shop_creative_hub_video_empty.xlsx');
    writeWorkbook(outputFile, [spec.headers]);
    const buffer = fs.readFileSync(outputFile);
    return {
      schema_version: 'shop_creative_hub_video_v3', status: 'no_data', ...resultIdentity(input),
      start_date: input.startDate, end_date: input.endDate, output_file: outputFile,
      byte_length: buffer.length, sha256: sha256(buffer), generated_file: true, row_count: 0,
      no_data_evidence: spec.no_data_rule,
    };
  }

  const createTarget = requestUrl(sellerOrigin, rules.create_endpoint, rules, input);
  const createBody = {
    [rules.request_fields.common_request]: commonRequest(rules, input.startDate, input.endDate, rules.common_request.create_page_size),
    [rules.create_action.field]: rules.create_action.value,
  };
  const created = await postJson(page, createTarget, createBody, rules.request_timeout_ms, 'official_task_create_result_unknown');
  const taskId = String(getPath(created, rules.response_paths.create_task_id) || '');
  if (!digits(taskId)) fail('official_task_id_invalid');

  let downloadUrl = null;
  const pollStartedAt = Date.now();
  const diagnostic = { task_id:taskId, attempts:0, candidate_count:0, exact_match_count:0, task_observed:false, last_status:null, url_present:false, status_counts:{} };
  const snapshot = (outcome) => ({ ...diagnostic, elapsed_ms:Date.now()-pollStartedAt, status_counts:{...diagnostic.status_counts}, ...(outcome ? { outcome } : {}) });
  const delay = dependencies.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < rules.max_polls; attempt += 1) {
    const queryTarget = requestUrl(sellerOrigin, rules.task_query_endpoint, rules, input);
    let queried;
    try { queried = await postJson(page, queryTarget, {
      [rules.request_fields.task_scene]: rules.scene,
      [rules.request_fields.task_id]: taskId,
    }, rules.request_timeout_ms, 'official_task_query_failed'); }
    catch (error) { error.diagnostics = snapshot('query_failed'); throw error; }
    const candidates = taskCandidates(queried, rules.response_paths);
    const matches = candidates.filter((candidate) => String(getPath(candidate, rules.response_paths.task_id) || '') === taskId);
    diagnostic.attempts = attempt + 1; diagnostic.candidate_count = candidates.length; diagnostic.exact_match_count = matches.length;
    if (matches.length > 1) fail('official_task_binding_mismatch', snapshot('duplicate_task'));
    const exact = matches[0];
    if (exact) {
      diagnostic.task_observed = true;
      const taskScene = getPath(exact, rules.response_paths.task_scene);
      if (taskScene !== undefined && taskScene !== null && String(taskScene) !== rules.scene) {
        fail('official_task_binding_mismatch', snapshot('scene_mismatch'));
      }
      const status = String(getPath(exact, rules.response_paths.task_status) || '');
      diagnostic.last_status = status || null; diagnostic.status_counts[status || '<empty>'] = (diagnostic.status_counts[status || '<empty>'] || 0) + 1;
      if (rules.task_statuses.failed.includes(status)) fail('official_task_failed', snapshot('failed'));
      if (rules.task_statuses.success.includes(status)) {
        downloadUrl = getPath(exact, rules.response_paths.task_url);
        diagnostic.url_present = text(downloadUrl);
        if (!diagnostic.url_present) fail('official_task_url_missing', snapshot('success_without_url'));
        break;
      }
      if (!rules.task_statuses.pending.includes(status)) fail('official_task_status_invalid', snapshot('unknown_status'));
    }
    if (attempt + 1 < rules.max_polls) await delay(rules.poll_interval_ms);
  }
  if (!downloadUrl) fail('official_task_timeout', snapshot(diagnostic.task_observed ? 'still_processing' : 'task_not_observed'));

  const downloaded = await downloadOfficial(dependencies.browserContext, downloadUrl, rules.download_timeout_ms);
  const dataRowCount = inspectWorkbook(downloaded.buffer, spec);
  const sourceHash = sha256(downloaded.buffer);
  const outputFile = path.join(outputDir, `${taskId}.xlsx`);
  fs.writeFileSync(outputFile, downloaded.buffer, { flag: 'wx' });
  const saved = fs.readFileSync(outputFile);
  if (saved.length !== downloaded.buffer.length || sha256(saved) !== sourceHash) fail('official_file_changed');
  return {
    schema_version: 'shop_creative_hub_video_v3', status: 'success', ...resultIdentity(input),
    start_date: input.startDate, end_date: input.endDate, task_id: taskId,
    output_file: outputFile, byte_length: saved.length,
    sha256: sourceHash, official_file_unchanged: true, data_row_count: dataRowCount,
  };
}

module.exports = { run, validateSpec };
