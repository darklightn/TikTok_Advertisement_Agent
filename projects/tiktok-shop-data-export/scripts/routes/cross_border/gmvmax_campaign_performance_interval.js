'use strict';

const { validateReportSpec } = require('../../common/md-spec-validator');
const { aggregate, getPath, writeArtifact } = require('../../common/shop-api-v3');
const { headers, row } = require('../common/gmvmax_campaign_performance_interval_v3');

const REPORT_ID = 'gmvmax_campaign_performance';
function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function endpoint(value) { const candidate = String(value || ''); return /^\/[a-z0-9_/-]+$/u.test(candidate) && !candidate.includes('//') && !candidate.includes('..'); }
function fieldPath(value) { return Array.isArray(value) && value.length > 0 && value.every((part) => text(part) || Number.isInteger(part)); }
function httpsOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; } }
function activePage(page, origin) { try { const url = new URL(page.url()); return url.origin === origin && !/(?:login|signin|passport)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }
function fields(value, names) { return object(value) && names.every((name) => text(value[name])) && new Set(names.map((name) => value[name])).size === names.length; }

function validateSpec(spec, providerSpec, options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('campaign_interval_spec_invalid'); }
  const contract = providerSpec?.api_contract; const response = contract?.campaign_response; const query = contract?.request_query;
  if (spec?.report_id !== REPORT_ID || spec.campaign_selection !== 'all_or_explicit'
    || spec.single_day_time_file !== true
    || spec.dynamic_headers !== 'top_level_field_union'
    || !Array.isArray(spec.headers) || spec.headers.join('\0') !== 'campaign_id\0campaign_name\0currency'
    || !Array.isArray(spec.required_key_columns) || spec.required_key_columns.some((key) => !spec.headers.includes(key))
    || spec.no_data_rule !== 'official_api_zero_total' || spec.providers?.cross_border !== providerSpec
    || providerSpec?.transport !== 'seller_page_post' || !httpsOrigin(providerSpec?.response_origin)
    || !fields(providerSpec.campaign_request_fields, ['start', 'end', 'page'])
    || !object(contract) || !endpoint(contract.campaign_endpoint) || !object(contract.campaign_request)
    || !object(query) || !text(query.seller) || !text(query.advertiser) || query.seller === query.advertiser
    || !Number.isInteger(query.timeout_ms) || query.timeout_ms < 1
    || Object.entries(query).some(([key, value]) => !['seller', 'advertiser', 'timeout_ms'].includes(key) && !['string', 'number', 'boolean'].includes(typeof value))
    || !object(response) || !fieldPath(response.records) || !fieldPath(response.pagination)
    || !['total', 'page_count', 'page', 'id', 'name'].every((key) => text(response[key]))) fail('campaign_interval_spec_invalid');
  return spec;
}
function assertSession(live) {
  if (!live.browser?.isConnected?.()) fail('browser_disconnected');
  if (!live.context || !live.browser.contexts?.().includes(live.context)) fail('browser_context_missing');
  if (!live.context.pages().includes(live.page)) fail('seller_page_missing');
  if (!activePage(live.page, live.origin)) fail('seller_origin_mismatch');
}
function assertFailureSession(input, dependencies) {
  if (!dependencies.browser?.isConnected?.()) fail('browser_disconnected');
  if (!dependencies.browserContext || !dependencies.browser.contexts?.().includes(dependencies.browserContext)) fail('browser_context_missing');
  let origin; try { origin = new URL(input?.b?.seller_page_url).origin; } catch { return; }
  const pages = dependencies.browserContext.pages?.() || [];
  if (pages.some((page) => activePage(page, origin))) return;
  if (pages.some((page) => { try { const url = new URL(page.url()); return url.origin === origin && /(?:login|signin|passport)(?:\/|$)/iu.test(url.pathname); } catch { return false; } })) fail('seller_login_page');
  fail('seller_origin_mismatch');
}
function requestQuery(live) {
  const { seller, advertiser, timeout_ms: _timeout, ...constants } = live.contract.request_query;
  return { ...constants, [seller]: live.sellerId, [advertiser]: live.advertiserId };
}
async function post(live, body, dependencies) {
  assertSession(live); const target = new URL(live.contract.campaign_endpoint, live.providerSpec.response_origin);
  for (const [key, value] of Object.entries(requestQuery(live))) target.searchParams.set(key, String(value));
  let result;
  try {
    if (dependencies.request) result = await dependencies.request(live.page, { url: target.href, method: 'POST', search_params: requestQuery(live), headers: { 'content-type': 'application/json' }, body, timeout_ms: live.contract.request_query.timeout_ms });
    else {
      const response = await live.page.request.fetch(target.href, { method: 'POST', headers: { 'content-type': 'application/json' }, data: body, timeout: live.contract.request_query.timeout_ms, failOnStatusCode: false });
      result = { http_status: response.status(), body: await response.json().catch(() => null), final_url: response.url() };
    }
  } catch { assertSession(live); fail('campaign_universe_api_error'); }
  assertSession(live);
  let final; try { final = new URL(result?.final_url || result?.url || target.href); } catch { fail('campaign_universe_api_error'); }
  if (final.origin !== live.providerSpec.response_origin || final.pathname !== live.contract.campaign_endpoint) fail('seller_origin_mismatch');
  if (final.searchParams.get(live.contract.request_query.seller) !== live.sellerId
    || final.searchParams.get(live.contract.request_query.advertiser) !== live.advertiserId) fail('provider_binding_invalid');
  if (result?.http_status !== 200 || result.body?.code !== 0) fail('campaign_universe_api_error');
  return result.body;
}
function campaignBody(providerSpec, startDate, endDate, page) {
  const body = structuredClone(providerSpec.api_contract.campaign_request); const fields = providerSpec.campaign_request_fields;
  body[fields.start] = startDate; body[fields.end] = endDate; body[fields.page] = page; return body;
}
async function collectCampaigns(live, startDate, endDate, dependencies) {
  const response = live.contract.campaign_response; const records = []; const ids = new Set(); let total = null; let pageCount = null;
  for (let page = 1; ; page += 1) {
    const body = await post(live, campaignBody(live.providerSpec, startDate, endDate, page), dependencies);
    const observed = getPath(body, response.records); const pagination = getPath(body, response.pagination);
    const observedTotal = pagination?.[response.total]; const observedPageCount = pagination?.[response.page_count];
    if (!Array.isArray(observed) || !Number.isInteger(observedTotal) || observedTotal < 0 || !Number.isInteger(observedPageCount) || observedPageCount < 0 || pagination?.[response.page] !== page) fail('campaign_universe_shape_invalid');
    if (total === null) { total = observedTotal; pageCount = observedPageCount; }
    if (total !== observedTotal || pageCount !== observedPageCount) fail('campaign_universe_pagination_changed');
    for (const item of observed) {
      const campaignId = String(getPath(item, [response.id]) || ''); const campaignName = String(getPath(item, [response.name]) || '').trim();
      if (!digits(campaignId) || ids.has(campaignId) || !campaignName) fail('campaign_universe_count_mismatch');
      ids.add(campaignId); records.push({ ...item, campaign_id: campaignId, campaign_name: campaignName });
    }
    if (page >= pageCount) break;
  }
  if (records.length !== total) fail('campaign_universe_count_mismatch'); return records;
}
function normalizedName(value) { return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' '); }
function selectCampaigns(campaigns, ref) {
  if (ref == null) return campaigns;
  const matches = digits(ref) ? campaigns.filter((item) => item.campaign_id === ref) : campaigns.filter((item) => normalizedName(item.campaign_name) === ref);
  if (!matches.length) fail('explicit_campaign_not_found_in_report_universe');
  if (matches.length !== 1) fail('explicit_campaign_ambiguous'); return matches;
}
function artifact(input, campaign, columns, currency) {
  const value = writeArtifact(input, { logical_table: 'report', headers: columns }, [row(campaign, columns, currency)], 'success', { campaign_id: campaign.campaign_id, campaign_name: campaign.campaign_name });
  delete value.logical_table; return value;
}
async function runInner(input, dependencies = {}) {
  if (input?.shop?.provider_id !== 'cross_border') fail('report_provider_unsupported');
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  const sellerId = String(input?.shop?.seller_id || ''); const advertiserId = String(input?.advertiserId || '');
  if (!digits(sellerId) || !digits(advertiserId) || !text(input?.advertiserName) || !text(input?.advertiserCurrency) || !dependencies.browser || !dependencies.browserContext) fail('advertiser_identity_missing');
  let origin; try { origin = new URL(input.b.seller_page_url).origin; } catch { fail('provider_binding_invalid'); }
  if (origin !== input.providerSpec.response_origin) fail('provider_binding_invalid');
  const page = dependencies.browserContext.pages().find((candidate) => activePage(candidate, origin)); if (!page) fail('seller_page_missing');
  const live = { browser: dependencies.browser, context: dependencies.browserContext, page, origin, sellerId, advertiserId, providerSpec: input.providerSpec, contract: input.providerSpec.api_contract };
  const campaigns = selectCampaigns(await collectCampaigns(live, input.startDate, input.endDate, dependencies), input.campaignRef);
  const columns = headers(campaigns);
  const artifacts = campaigns.map((campaign) => artifact(input, campaign, columns, input.advertiserCurrency));
  return { status: aggregate(artifacts), report_id: REPORT_ID, shop_id: sellerId, seller_id: sellerId, provider_id: 'cross_border', advertiser_id: advertiserId, business_center_id: String(input.businessCenterId || ''), artifacts };
}
async function run(input, dependencies = {}) { try { return await runInner(input, dependencies); } catch (error) { if (dependencies.browser) assertFailureSession(input, dependencies); throw error; } }

module.exports = { campaignBody, run, selectCampaigns, validateSpec };
