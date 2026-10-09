'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { countXlsxDataRows } = require('../../common/official_download_rows');
const { writeWorkbook } = require('../../common/xlsx_writer');
const FATAL_REASONS = new Set([
  'browser_disconnected', 'browser_context_missing', 'seller_login_page', 'seller_origin_mismatch',
  'seller_page_missing', 'result_shop_identity_mismatch', 'result_advertiser_identity_mismatch',
  'transport_login_required', 'provider_binding_invalid',
]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function uniqueText(values) {
  return Array.isArray(values) && values.length > 0 && values.every(text)
    && new Set(values).size === values.length;
}
function endpoint(value) {
  return /^\/[a-z0-9_/-]+$/u.test(String(value || '')) && !value.includes('//') && !value.includes('..');
}
function fieldPath(value) {
  return Array.isArray(value) && value.length > 0 && value.every((part) => /^[a-z0-9_]+$/u.test(part));
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function getPath(value, parts) { return parts.reduce((current, part) => current?.[part], value); }
function normalizeName(value) { return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' '); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function inspectWorkbook(buffer, spec, providerSpec) {
  return countXlsxDataRows(buffer, providerSpec.official_validation.data_start_row);
}
function validateListRequest(value) {
  if (!object(value) || !uniqueText(value.query_list) || !text(value.order_field)
    || !Number.isInteger(value.order_type) || !Number.isInteger(value.page_size) || value.page_size < 1) {
    fail('campaign_product_report_spec_invalid');
  }
}

function validateSpec(spec, providerSpec, options = {}) {
  try { validateReportSpec({ ...spec, providers: { cross_border: providerSpec } }, options); }
  catch { fail('campaign_product_report_spec_invalid'); }
  const rules = providerSpec?.official_validation; const providers = spec?.providers;
  if (spec.schema_version !== 'report_spec_v1'
    || spec.report_id !== 'gmvmax_campaign_product_performance'
    || spec.enabled !== true || spec.explicit_only !== false || spec.owner_scope !== 'campaign'
    || JSON.stringify(spec.required_variables) !== JSON.stringify(['shop', 'advertiser', 'campaign', 'start_date', 'end_date'])
    || spec.campaign_selection !== 'all_or_explicit'
    || spec.source_type !== 'official_download' || spec.success_output_type !== 'official_xlsx'
    || spec.no_data_output_type !== 'generated_xlsx' || spec.time_semantics !== 'requested_range'
    || spec.output_granularity !== 'request_range' || spec.single_day_time_file !== true || !text(spec.output_path_template)
    || !uniqueText(spec.headers) || spec.no_data_rule !== 'official_product_total_zero'
    || !object(providers) || providers.cross_border !== providerSpec
    || providerSpec?.transport !== 'seller_page_request_bound_official_task_download' || !object(rules)) fail('campaign_product_report_spec_invalid');
  let responseOrigin; try { responseOrigin = new URL(providerSpec.response_origin); } catch { fail('campaign_product_report_spec_invalid'); }
  if (responseOrigin.protocol !== 'https:' || responseOrigin.origin !== providerSpec.response_origin) fail('campaign_product_report_spec_invalid');
  if (![rules.campaign_endpoint, rules.product_endpoint, rules.task_query_endpoint].every(endpoint)) {
    fail('campaign_product_report_spec_invalid');
  }
  if (!object(rules.query_parameters) || !['seller_id','advertiser_id','locale','language'].every((key) => text(rules.query_parameters[key]))
    || !object(rules.identity_response_fields)
    || !uniqueText(rules.identity_response_fields.seller) || !uniqueText(rules.identity_response_fields.advertiser)
    || !object(rules.query_constants)
    || !text(rules.query_constants.locale) || !text(rules.query_constants.language)) {
    fail('campaign_product_report_spec_invalid');
  }
  const requestFields = new Set(['start_date','end_date','page','page_size','campaign_id','query_list','order_field','order_type','automation_type','external_type_list','filters','action','task_id']);
  if (!object(rules.request_fields) || [...requestFields].some((key) => !text(rules.request_fields[key]))) fail('campaign_product_report_spec_invalid');
  validateListRequest(rules.campaign_request);
  if (!Number.isInteger(rules.campaign_request.campaign_shop_automation_type)
    || !uniqueText(rules.campaign_request.external_type_list)
    || !Array.isArray(rules.campaign_request.filters) || rules.campaign_request.filters.length) {
    fail('campaign_product_report_spec_invalid');
  }
  validateListRequest(rules.product_request);
  if (!object(rules.create_request) || !uniqueText(rules.create_request.query_list)
    || !text(rules.create_request.order_field) || !Number.isInteger(rules.create_request.order_type)
    || !Number.isInteger(rules.create_request.page_size) || rules.create_request.page_size >= 0
    || !text(rules.create_request.action)) {
    fail('campaign_product_report_spec_invalid');
  }
  const responseFields = new Set([
    'table', 'pagination', 'total', 'page_count', 'page', 'campaign_id', 'campaign_name', 'product_id',
    'create_task_id', 'task_id', 'task_status', 'task_url',
  ]);
  if (!object(rules.response_paths) || [...responseFields].some((key) => rules.response_paths[key] === undefined)
    || ['total','page_count','page'].some((key)=>!text(rules.response_paths[key]))
    || [...responseFields].some((key) => !['total','page_count','page'].includes(key) && !fieldPath(rules.response_paths[key]))) fail('campaign_product_report_spec_invalid');
  if (!object(rules.task_statuses)
    || !uniqueText(rules.task_statuses.pending) || !uniqueText(rules.task_statuses.success)
    || !uniqueText(rules.task_statuses.failed)
    || new Set([...rules.task_statuses.pending, ...rules.task_statuses.success, ...rules.task_statuses.failed]).size
      !== rules.task_statuses.pending.length + rules.task_statuses.success.length + rules.task_statuses.failed.length) {
    fail('campaign_product_report_spec_invalid');
  }
  if (!Number.isInteger(rules.poll_interval_ms)
    || rules.poll_interval_ms < 0 || !Number.isInteger(rules.max_polls) || rules.max_polls < 1
    || !Number.isInteger(rules.request_timeout_ms) || rules.request_timeout_ms < 1
    || !Number.isInteger(rules.download_timeout_ms) || rules.download_timeout_ms < 1
    || !Number.isInteger(rules.data_start_row) || rules.data_start_row < 1) fail('campaign_product_report_spec_invalid');
  return spec;
}

function isActiveSellerPage(page, origin) {
  try {
    const current = new URL(page.url());
    return current.origin === origin && !/(?:account\/)?(?:login|signin)(?:\/|$)/iu.test(current.pathname);
  } catch { return false; }
}
function assertBorrowedSession(context) {
  if (typeof context?.browser?.isConnected !== 'function' || !context.browser.isConnected()) fail('browser_disconnected');
  if (!context.browserContext || typeof context.browserContext.pages !== 'function') fail('browser_context_missing');
  let contexts;
  try { contexts = typeof context.browser.contexts === 'function' ? context.browser.contexts() : []; }
  catch { fail('browser_context_missing'); }
  if (!contexts.includes(context.browserContext)) fail('browser_context_missing');
  let pages;
  try { pages = context.browserContext.pages(); } catch { fail('browser_context_missing'); }
  if (!pages.includes(context.page)) fail('seller_page_missing');
  if (!isActiveSellerPage(context.page, context.sellerOrigin)) {
    let current;
    try { current = new URL(context.page.url()); } catch { fail('seller_origin_mismatch'); }
    if (current.origin === context.sellerOrigin) fail('seller_login_page');
    fail('seller_origin_mismatch');
  }
}
async function borrowedCall(context, operation, failureCode) {
  assertBorrowedSession(context);
  let value;
  try { value = await operation(); }
  catch { assertBorrowedSession(context); fail(failureCode); }
  assertBorrowedSession(context);
  return value;
}

function validateInput(input, dependencies) {
  if (input?.shop?.provider_id !== 'cross_border') fail('report_provider_unsupported');
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot:dependencies.skillRoot });
  if (!object(input.a) || !object(input.b) || !object(input.shop)
    || !digits(input.shop.seller_id) || !digits(input.advertiserId) || !digits(input.businessCenterId)
    || !dependencies?.browser || !dependencies.browserContext
    || !validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate
    || (input.campaignRef !== null && input.campaignRef !== undefined && !text(input.campaignRef))
    ) {
    fail('campaign_product_input_invalid');
  }
  const outputDir = path.resolve(String(input.outputDir || ''));
  if (!fs.statSync(outputDir, { throwIfNoEntry: false })?.isDirectory() || fs.readdirSync(outputDir).length) {
    fail('output_directory_invalid');
  }
  let sellerOrigin;
  try {
    const sellerUrl = new URL(input.b.seller_page_url);
    if (sellerUrl.protocol !== 'https:') fail('provider_binding_invalid');
    sellerOrigin = sellerUrl.origin;
  } catch { fail('provider_binding_invalid'); }
  if (sellerOrigin !== input.providerSpec.response_origin) fail('provider_binding_invalid');
  const pages = dependencies.browserContext.pages?.() || [];
  const page = pages.find((candidate) => isActiveSellerPage(candidate, sellerOrigin));
  if (!page?.request || typeof page.request.fetch !== 'function') fail('seller_page_missing');
  const context = { outputDir, page, sellerOrigin, responseOrigin:input.providerSpec.response_origin, browser:dependencies.browser, browserContext:dependencies.browserContext };
  assertBorrowedSession(context); return context;
}

function requestUrl(origin, endpointPath, rules, input) {
  const target = new URL(endpointPath, origin); const parameters = rules.query_parameters;
  target.searchParams.set(parameters.seller_id, String(input.shop.seller_id));
  target.searchParams.set(parameters.advertiser_id, String(input.advertiserId));
  target.searchParams.set(parameters.locale, rules.query_constants.locale);
  target.searchParams.set(parameters.language, rules.query_constants.language);
  return target;
}
function responseStatus(response) { return typeof response?.status === 'function' ? response.status() : response?.status; }
function responseUrl(response) { return typeof response?.url === 'function' ? response.url() : response?.url; }
function responseHeaders(response) { return typeof response?.headers === 'function' ? response.headers() : (response?.headers || {}); }
async function responseBuffer(response) {
  if (typeof response?.body === 'function') return response.body();
  if (Buffer.isBuffer(response?.body)) return response.body;
  fail('transport_response_invalid');
}
function assertResponseIdentity(body, input) {
  const identity = input.providerSpec.official_validation.identity_response_fields;
  for (const candidate of [body, body?.data]) {
    if (!object(candidate)) continue;
    for (const field of identity.seller) {
      if (candidate[field] !== undefined && String(candidate[field]) !== String(input.shop.seller_id)) {
        fail('result_shop_identity_mismatch');
      }
    }
    for (const field of identity.advertiser) {
      if (candidate[field] !== undefined && String(candidate[field]) !== String(input.advertiserId)) {
        fail('result_advertiser_identity_mismatch');
      }
    }
  }
}
async function postJson(context, target, body, timeout, failureCode, input) {
  const response = await borrowedCall(context, () => context.page.request.fetch(target.href, {
    method: 'POST', headers: { 'content-type': 'application/json' }, data: body,
    timeout, failOnStatusCode: false,
  }), failureCode);
  if ([401, 403].includes(responseStatus(response))) fail('transport_login_required');
  if (responseStatus(response) !== 200) fail(failureCode);
  let final;
  try { final = new URL(responseUrl(response)); } catch { fail(failureCode); }
  if (final.origin !== target.origin || final.pathname !== target.pathname) fail('seller_origin_mismatch');
  for (const [key, value] of target.searchParams) if (final.searchParams.get(key) !== value) fail('seller_origin_mismatch');
  let parsed;
  try { parsed = JSON.parse((await borrowedCall(context, () => responseBuffer(response), failureCode)).toString('utf8')); }
  catch (error) { if (isFatal(error)) throw error; fail(failureCode); }
  if (!object(parsed) || parsed.code !== 0) fail(failureCode);
  assertResponseIdentity(parsed, input); return parsed;
}

function listBody(contract, input, page, options = {}) {
  const fields=input.providerSpec.official_validation.request_fields;
  const body = {
    [fields.query_list]: [...contract.query_list], [fields.start_date]: input.startDate, [fields.end_date]: input.endDate,
    [fields.order_field]: contract.order_field, [fields.order_type]: contract.order_type, [fields.page]: page, [fields.page_size]: contract.page_size,
  };
  if (options.campaignId !== undefined) body[fields.campaign_id] = String(options.campaignId);
  if (contract.campaign_shop_automation_type !== undefined) {
    body[fields.automation_type] = contract.campaign_shop_automation_type;
    body[fields.external_type_list] = [...contract.external_type_list];
  }
  if (contract.filters?.length) body[fields.filters] = contract.filters.map((filter) => structuredClone(filter));
  return body;
}
async function collectPages(context, endpointPath, contract, rules, input, options, idPath, failureCode) {
  const rows = []; let officialTotal = null; let officialPageCount = null;
  for (let page = 1; ; page += 1) {
    const body = await postJson(context, requestUrl(context.responseOrigin, endpointPath, rules, input),
      listBody(contract, input, page, options), rules.request_timeout_ms, failureCode, input);
    const table = getPath(body, rules.response_paths.table); const pagination = getPath(body, rules.response_paths.pagination);
    const totalValue=pagination?.[rules.response_paths.total]; const pageCountValue=pagination?.[rules.response_paths.page_count]; const pageValue=pagination?.[rules.response_paths.page];
    if (!Array.isArray(table) || !object(pagination) || !Number.isInteger(totalValue)
      || !Number.isInteger(pageCountValue) || !Number.isInteger(pageValue)
      || totalValue < 0 || pageCountValue < 0 || pageValue !== page) fail(failureCode);
    if (officialTotal === null) { officialTotal = totalValue; officialPageCount = pageCountValue; }
    else if (officialTotal !== totalValue || officialPageCount !== pageCountValue) fail(failureCode);
    rows.push(...table); if (page >= officialPageCount) break;
  }
  if (rows.length !== officialTotal) fail(failureCode);
  const seen = new Set();
  for (const row of rows) {
    const id = String(getPath(row, idPath) || '');
    if (!digits(id) || seen.has(id)) fail(failureCode);
    seen.add(id);
  }
  return rows;
}
function selectCampaigns(rows, rules, campaignRef) {
  const campaigns = rows.map((row) => ({
    campaign_id: String(getPath(row, rules.response_paths.campaign_id) || ''),
    campaign_name: normalizeName(getPath(row, rules.response_paths.campaign_name)),
  }));
  if (campaigns.some((item) => !digits(item.campaign_id) || !item.campaign_name)) fail('campaign_discovery_incomplete');
  if (campaignRef === null || campaignRef === undefined) return campaigns;
  const normalized = normalizeName(campaignRef);
  const matches = digits(normalized)
    ? campaigns.filter((item) => item.campaign_id === normalized)
    : campaigns.filter((item) => item.campaign_name === normalized);
  if (!matches.length) fail('explicit_campaign_not_found_in_report_universe');
  if (matches.length > 1) fail('explicit_campaign_ambiguous');
  return matches;
}
async function downloadOfficial(context, signedUrl, timeout) {
  let target;
  try { target = new URL(signedUrl); } catch { fail('official_download_url_invalid'); }
  if (target.protocol !== 'https:' || !target.hostname || target.username || target.password
    || /\s/u.test(String(signedUrl)) || /(?:login|signin)(?:\/|$)/iu.test(target.pathname)) fail('official_download_url_invalid');
  const response = await borrowedCall(context, () => context.browserContext.request.get(target.href, {
    timeout, failOnStatusCode: false,
  }), 'official_download_failed');
  if ([401, 403].includes(responseStatus(response))) fail('transport_login_required');
  if (responseStatus(response) !== 200) fail('official_download_failed');
  let final;
  try { final = new URL(responseUrl(response)); } catch { fail('official_download_failed'); }
  if (/(?:login|signin)(?:\/|$)/iu.test(final.pathname)) fail('transport_login_required');
  const headers = responseHeaders(response);
  const buffer = await borrowedCall(context, () => responseBuffer(response), 'official_download_failed');
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  if (contentType.includes('text/html') || buffer[0] !== 0x50 || buffer[1] !== 0x4b) fail('official_download_invalid');
  return { buffer };
}
function isFatal(error) {
  return FATAL_REASONS.has(error?.code) || /(?:^|_)(?:identity_mismatch|cdp_disconnected)$/u.test(error?.code || '');
}
function artifactStatus(artifacts) {
  if (!artifacts.length || artifacts.every((item) => item.status === 'no_data')) return 'no_data';
  const failed = artifacts.filter((item) => item.status === 'failed').length;
  if (!failed && artifacts.some((item) => item.status === 'success')) return 'success';
  if (failed < artifacts.length) return 'partial';
  return 'failed';
}
function resultIdentity(input) {
  return {
    shop_id: String(input.shop.seller_id), seller_id: String(input.shop.seller_id),
    oec_seller_id: String(input.shop.seller_id), advertiser_id: String(input.advertiserId),
    business_center_id: String(input.businessCenterId), provider_id: input.shop.provider_id,
  };
}

async function createArtifact(input, dependencies, context, unit) {
  const spec = input.reportSpec; const rules = input.providerSpec.official_validation;
  if (unit.official_total_count === 0) {
    const outputFile = path.join(context.outputDir, `${unit.campaign_id}_empty.xlsx`);
    writeWorkbook(outputFile, [spec.headers]); const buffer = fs.readFileSync(outputFile);
    return {
      status: 'no_data', ...unit, output_file: outputFile,
      byte_length: buffer.length, sha256: sha256(buffer), generated_file: true, row_count: 0,
      no_data_evidence: spec.no_data_rule,
    };
  }
  const requestUnit = { campaignId: unit.campaign_id };
  const createBody = listBody(rules.create_request, input, 1, requestUnit);
  createBody[rules.request_fields.action] = rules.create_request.action;
  const created = await postJson(context, requestUrl(context.responseOrigin, rules.product_endpoint, rules, input),
    createBody, rules.request_timeout_ms, 'official_task_create_result_unknown', input);
  const taskId = String(getPath(created, rules.response_paths.create_task_id) || '');
  if (!digits(taskId)) fail('official_task_id_invalid');
  let downloadUrl = null; const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < rules.max_polls; attempt += 1) {
    const queried = await postJson(context, requestUrl(context.responseOrigin, rules.task_query_endpoint, rules, input),
        { [rules.request_fields.task_id]: taskId }, rules.request_timeout_ms, 'official_task_query_failed', input);
    if (String(getPath(queried, rules.response_paths.task_id) || '') !== taskId) fail('official_task_binding_mismatch');
    const status = String(getPath(queried, rules.response_paths.task_status) || '');
    if (rules.task_statuses.failed.includes(status)) fail('official_task_failed');
    if (rules.task_statuses.success.includes(status)) {
      downloadUrl = getPath(queried, rules.response_paths.task_url);
      if (!text(downloadUrl)) fail('official_task_url_missing');
      break;
    }
    if (!rules.task_statuses.pending.includes(status)) fail('official_task_status_invalid');
    if (attempt + 1 < rules.max_polls) await delay(rules.poll_interval_ms);
  }
  if (!downloadUrl) fail('official_task_timeout');
  const downloaded = await downloadOfficial(context, downloadUrl, rules.download_timeout_ms);
  const dataRowCount = inspectWorkbook(downloaded.buffer, spec, input.providerSpec); const hash = sha256(downloaded.buffer);
  const outputFile = path.join(context.outputDir, `${taskId}.xlsx`);
  fs.writeFileSync(outputFile, downloaded.buffer, { flag: 'wx' }); const saved = fs.readFileSync(outputFile);
  if (saved.length !== downloaded.buffer.length || sha256(saved) !== hash) fail('official_file_changed');
  return {
    status: 'success', ...unit, task_id: taskId,
    output_file: outputFile, byte_length: saved.length,
    sha256: hash, official_file_unchanged: true, data_row_count: dataRowCount,
  };
}

async function run(input, dependencies = {}) {
  const context = validateInput(input, dependencies); const spec = input.reportSpec; const rules = input.providerSpec.official_validation;
  const campaignRows = await collectPages(context, rules.campaign_endpoint, rules.campaign_request, rules, input, {},
    rules.response_paths.campaign_id, 'campaign_discovery_incomplete');
  const campaigns = selectCampaigns(campaignRows, rules, input.campaignRef ?? null);
  if (!campaigns.length) {
    return { schema_version: 'gmvmax_campaign_product_performance_v3', status: 'no_data',
      ...resultIdentity(input), start_date: input.startDate, end_date: input.endDate, artifacts: [] };
  }
  const discovered = [];
  for (const campaign of campaigns) {
    const products = await collectPages(context, rules.product_endpoint, rules.product_request, rules, input,
      { campaignId: campaign.campaign_id }, rules.response_paths.product_id, 'product_discovery_incomplete');
    discovered.push({ ...campaign, official_total_count: products.length });
  }
  const artifacts = [];
  for (const unit of discovered) {
    try { artifacts.push(await createArtifact(input, dependencies, context, unit)); }
    catch (error) {
      if (isFatal(error)) throw error;
      artifacts.push({
        status: 'failed', campaign_id: unit.campaign_id, campaign_name: unit.campaign_name,
        reason_code: error?.code || 'campaign_product_artifact_failed',
      });
    }
  }
  return {
    schema_version: 'gmvmax_campaign_product_performance_v3', status: artifactStatus(artifacts),
    ...resultIdentity(input), start_date: input.startDate, end_date: input.endDate, artifacts,
  };
}

module.exports = { inspectWorkbook, run, validateSpec };
