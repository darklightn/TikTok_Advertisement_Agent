'use strict';

const crypto = require('crypto');
const { openExactShop } = require('../a_open_shop');
const { attachShop, isSellerUrl } = require('../b_attach_shop');
const { loadReportMd, resolveReportIds } = require('../load-report-md');
const { connectExistingBrowser } = require('./playwright_runtime');
const { loadPipelineRuntimeConfig } = require('./pipeline_runtime_config');
const { businessDate } = require('./date_range');
const { identifyShop } = require('./shop_identification');
const { resolveShopRoot } = require('./shop-root');

const IDENTITY_PATH = '/api/v3/seller/common/get?need_verify_account=true&version=3';
const ONBOARD_PATH = '/oec_ads/shopping/v1/oec/get_onboard_info';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function normalizedAccountName(value) { return String(value).normalize('NFKC').trim().toLowerCase(); }
function normalizedCampaignRef(value) { return String(value).normalize('NFKC').trim().replace(/\s+/gu, ' '); }

function parseRunRequest(request, options = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('run_request_invalid');
  const shopRef = String(request.shop || '').normalize('NFKC').trim();
  if (!shopRef) fail('shop_ref_invalid');
  if (!Array.isArray(request.report_scopes) || !request.report_scopes.length
    || request.report_scopes.some((scope) => typeof scope !== 'string' || !scope.trim())) fail('report_scopes_invalid');
  let advertiserRef = null;
  if (request.advertiser !== undefined && request.advertiser !== null) {
    if (typeof request.advertiser !== 'string') fail('advertiser_ref_invalid');
    advertiserRef = request.advertiser.normalize('NFKC').trim();
    if (!advertiserRef) fail('advertiser_ref_invalid');
  }
  let campaignRef = null;
  if (request.campaign !== undefined && request.campaign !== null) {
    if (typeof request.campaign !== 'string') fail('campaign_ref_invalid');
    campaignRef = normalizedCampaignRef(request.campaign);
    if (!campaignRef) fail('campaign_ref_invalid');
  }
  let productRef = null;
  if (request.product !== undefined && request.product !== null) {
    if (typeof request.product !== 'string') fail('product_ref_invalid');
    productRef = normalizedCampaignRef(request.product);
    if (!productRef) fail('product_ref_invalid');
  }
  const loaded = options.loaded || (options.loadReportMd || loadReportMd)(options.mdOptions);
  const reportIds = [];
  const seen = new Set();
  for (const scope of request.report_scopes) {
    for (const reportId of resolveReportIds(scope, loaded)) {
      if (!seen.has(reportId)) { seen.add(reportId); reportIds.push(reportId); }
    }
  }
  const specs = reportIds.map((reportId) => loaded.specs[reportId]);
  if (specs.some((spec) => !spec)) fail('report_spec_missing');
  if (specs.some((spec) => spec.enabled !== true)) fail('report_disabled');
  const required = new Set(specs.flatMap((spec) => spec.required_variables));
  const hasStart = request.start_date !== undefined && request.start_date !== null && request.start_date !== '';
  const hasEnd = request.end_date !== undefined && request.end_date !== null && request.end_date !== '';
  if (hasStart !== hasEnd) fail('date_range_invalid');
  if (hasStart && (!validDate(request.start_date) || !validDate(request.end_date) || request.start_date > request.end_date)) fail('date_range_invalid');
  if ((required.has('start_date') || required.has('end_date')) && !hasStart) fail('date_range_required');
  const needsAdvertiser = required.has('advertiser') || advertiserRef !== null;
  const campaignSpecs = specs.filter((spec) => spec.required_variables.includes('campaign'));
  if (campaignRef !== null && !campaignSpecs.length) fail('campaign_ref_unexpected');
  if (campaignSpecs.some((spec) => spec.campaign_selection !== 'all_or_explicit')) fail('campaign_selection_unsupported');
  const productSpecs = specs.filter((spec) => spec.required_variables.includes('product'));
  if (productRef !== null && !productSpecs.length) fail('product_ref_unexpected');
  if (productSpecs.some((spec) => spec.product_selection !== 'all_or_explicit')) fail('product_selection_unsupported');
  return deepFreeze({
    shop_ref: shopRef,
    report_ids: reportIds,
    start_date: hasStart ? request.start_date : null,
    end_date: hasEnd ? request.end_date : null,
    advertiser_ref: advertiserRef, needsAdvertiser, campaign_ref: campaignRef, product_ref: productRef,
  });
}

function pageOrigin(page) {
  try { return new URL(page.url()).origin; } catch { return ''; }
}

async function readAuthoritativeShopIdentity(browser, browserContext, b, options = {}) {
  if (typeof browser?.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  if (!browserContext || typeof browserContext.pages !== 'function') fail('browser_context_missing');
  let origin;
  try { origin = new URL(b?.seller_page_url).origin; } catch { fail('seller_origin_invalid'); }
  const sameOrigin = browserContext.pages().filter((page) => pageOrigin(page) === origin);
  const page = sameOrigin.find((candidate) => isSellerUrl(candidate.url()));
  if (!page) {
    if (sameOrigin.length) fail('seller_login_page');
    fail('seller_page_missing');
  }
  if (pageOrigin(page) !== origin || typeof page.request?.get !== 'function') fail('seller_origin_mismatch');
  const target = new URL(IDENTITY_PATH, origin).toString();
  let response;
  try { response = await page.request.get(target, { timeout: Number(options.timeoutMs || 30000) }); }
  catch {
    if (typeof browser?.isConnected === 'function' && !browser.isConnected()) fail('browser_disconnected');
    fail('shop_identity_read_failed');
  }
  if (typeof browser.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  if (!isSellerUrl(page.url()) || pageOrigin(page) !== origin) fail('seller_origin_mismatch');
  let responseOrigin; let responseUrl;
  try { responseUrl = typeof response?.url === 'function' ? response.url() : ''; responseOrigin = new URL(responseUrl).origin; } catch { responseOrigin = ''; }
  if (responseOrigin !== origin) fail('seller_origin_mismatch');
  if (responseUrl !== target) fail('shop_identity_response_invalid');
  if (typeof response.status !== 'function' || response.status() !== 200) fail('shop_identity_http_error');
  let body;
  try { body = await response.json(); } catch { fail('shop_identity_response_invalid'); }
  if (!browser.isConnected()) fail('browser_disconnected');
  if (body?.code !== 0) fail('shop_identity_business_error');
  const seller = body?.data?.seller;
  const sellerId = String(seller?.seller_id || '').trim();
  if (!/^\d+$/u.test(sellerId)) fail('shop_identity_invalid');
  const shopCode = typeof seller?.shop_code === 'string' ? seller.shop_code.trim() : '';
  const shopRegion = typeof seller?.shop_region === 'string' ? seller.shop_region.trim() : '';
  const regionCode = typeof seller?.region_code === 'string' ? seller.region_code.trim() : '';
  if (!shopCode || !shopRegion || !regionCode
    || !Number.isInteger(seller?.seller_type) || !Number.isInteger(seller?.business_type)) {
    fail('shop_identity_invalid');
  }
  return {
    seller_id: sellerId, shop_code: shopCode,
    seller_type: seller.seller_type, business_type: seller.business_type,
    shop_region: shopRegion, region_code: regionCode,
  };
}

function selectAdvertiser(data, advertiserRef) {
  if (!object(data) || !/^\d+$/u.test(String(data.primary_adv_id ?? '').trim()) || !Array.isArray(data.adv_info_in_bc)) {
    fail('advertiser_context_shape_invalid');
  }
  const accounts = data.adv_info_in_bc.map((item) => {
    const advertiserId = String(item?.id ?? '').trim();
    const advertiserName = typeof item?.name === 'string' ? item.name.trim() : '';
    const advertiserCurrency = typeof item?.currency?.name === 'string' ? item.currency.name.trim() : '';
    if (!object(item) || !/^\d+$/u.test(advertiserId) || !advertiserName
      || !Number.isInteger(item.role) || !Number.isInteger(item.status) || !Number.isInteger(item.relation_status)) {
      fail('advertiser_context_shape_invalid');
    }
    return { advertiser_id: advertiserId, advertiser_name: advertiserName, advertiser_currency: advertiserCurrency, role: item.role, status: item.status, relation_status: item.relation_status };
  });
  if (new Set(accounts.map((item) => item.advertiser_id)).size !== accounts.length) fail('advertiser_context_shape_invalid');
  const eligible = accounts.filter((item) => item.role !== -1 && item.status === 4 && item.relation_status === 1);
  if (!eligible.length) fail('advertiser_accounts_missing');
  if (advertiserRef === null) {
    const primaryId = String(data.primary_adv_id).trim();
    const primary = eligible.find((item) => item.advertiser_id === primaryId);
    if (!primary) fail('primary_advertiser_ineligible');
    return primary;
  }
  const matches = /^\d+$/u.test(advertiserRef)
    ? eligible.filter((item) => item.advertiser_id === advertiserRef)
    : eligible.filter((item) => normalizedAccountName(item.advertiser_name) === normalizedAccountName(advertiserRef));
  if (!matches.length) fail('advertiser_not_found');
  if (matches.length > 1) fail('advertiser_ambiguous');
  return matches[0];
}

async function readAuthoritativeAdvertiser(browser, browserContext, b, sellerId, advertiserRef = null, options = {}) {
  if (typeof browser?.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  if (!browserContext || typeof browserContext.pages !== 'function') fail('browser_context_missing');
  let origin;
  try { origin = new URL(b?.seller_page_url).origin; } catch { fail('seller_origin_invalid'); }
  const sameOrigin = browserContext.pages().filter((page) => pageOrigin(page) === origin);
  const page = sameOrigin.find((candidate) => isSellerUrl(candidate.url()));
  if (!page) {
    if (sameOrigin.length) fail('seller_login_page');
    fail('seller_page_missing');
  }
  if (pageOrigin(page) !== origin || typeof page.request?.get !== 'function') fail('seller_origin_mismatch');
  const target = new URL(ONBOARD_PATH, origin);
  target.searchParams.set('oec_seller_id', sellerId); target.searchParams.set('seller_id', sellerId);
  let response;
  try { response = await page.request.get(target.toString(), { timeout: Number(options.timeoutMs || 30000) }); }
  catch {
    if (typeof browser?.isConnected === 'function' && !browser.isConnected()) fail('browser_disconnected');
    fail('advertiser_context_transport_failed');
  }
  if (typeof browser.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  if (!isSellerUrl(page.url()) || pageOrigin(page) !== origin) fail('seller_origin_mismatch');
  let responseUrl;
  try { responseUrl = typeof response?.url === 'function' ? response.url() : ''; }
  catch { responseUrl = ''; }
  if (responseUrl !== target.toString()) fail('advertiser_context_response_invalid');
  if (typeof response.status !== 'function' || response.status() !== 200) fail('advertiser_context_http_error');
  let body;
  try { body = await response.json(); } catch { fail('advertiser_context_response_invalid'); }
  if (!browser.isConnected()) fail('browser_disconnected');
  if (!object(body)) fail('advertiser_context_shape_invalid');
  if (body.code !== 0) fail('advertiser_context_business_error');
  if (!object(body.data)) fail('advertiser_context_shape_invalid');
  for (const field of ['seller_id', 'oec_seller_id']) {
    if (body.data[field] !== undefined && String(body.data[field]).trim() !== sellerId) fail('advertiser_seller_identity_mismatch');
  }
  if (!object(body.data.bind_bc_info)) fail('advertiser_context_shape_invalid');
  const businessCenterId = String(body.data.bind_bc_info.id ?? '').trim();
  if (!/^\d+$/u.test(businessCenterId)) fail('advertiser_context_shape_invalid');
  const selected = selectAdvertiser(body.data, advertiserRef);
  return {
    advertiser_id: selected.advertiser_id,
    advertiser_name: selected.advertiser_name,
    advertiser_currency: selected.advertiser_currency || null,
    business_center_id: businessCenterId,
  };
}

async function createRunSession(request, dependencies = {}) {
  const parsed = parseRunRequest(request, dependencies);
  let collectionDate;
  try {
    const clock = dependencies.clock || (() => new Date());
    collectionDate = businessDate(clock(), 'Asia/Manila');
  } catch {
    fail('collection_date_invalid');
  }
  const dataDepartmentRoot = dependencies.dataDepartmentRoot
    || (dependencies.loadPipelineRuntimeConfig || loadPipelineRuntimeConfig)(dependencies.runtimeConfigOptions).data_department_root;
  const open = dependencies.openExactShop || openExactShop;
  const attach = dependencies.attachShop || attachShop;
  const identify = dependencies.identifyShop || identifyShop;
  const connect = dependencies.connect || dependencies.connectExistingBrowser || connectExistingBrowser;
  const readIdentity = dependencies.readAuthoritativeShopIdentity || readAuthoritativeShopIdentity;
  const readAdvertiser = dependencies.readAuthoritativeAdvertiser || readAuthoritativeAdvertiser;
  let browser = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (browser && typeof browser.close === 'function') await browser.close().catch(() => {});
  };
  try {
    const a = await open(parsed.shop_ref, dependencies.openDependencies);
    const b = await attach({ shopAlias: a.shop_alias, browserId: String(a.browser_id), cdpUrl: a.cdp_url }, dependencies.attachDependencies);
    browser = await connect(a.cdp_url, { ...(dependencies.connectOptions || {}), attempts: 1 });
    const browserContext = browser.contexts?.()[0];
    if (!browserContext) fail('browser_context_missing');
    const identity = await readIdentity(browser, browserContext, b, dependencies.identityReadOptions);
    const identified = await identify(a, b, identity);
    const sellerId = String(identity?.seller_id || '');
    if (!/^\d+$/u.test(sellerId)) fail('shop_identity_invalid');
    const advertiser = parsed.needsAdvertiser
      ? await readAdvertiser(browser, browserContext, b, sellerId, parsed.advertiser_ref, dependencies.advertiserReadOptions)
      : { advertiser_id: null, advertiser_name: null, advertiser_currency: null, business_center_id: null };
    if (parsed.needsAdvertiser && (!/^\d+$/u.test(String(advertiser?.advertiser_id || ''))
      || typeof advertiser?.advertiser_name !== 'string' || !advertiser.advertiser_name.trim()
      || !/^\d+$/u.test(String(advertiser?.business_center_id || '')))) {
      fail('advertiser_context_shape_invalid');
    }
    const shopName = String(a.shop_alias || '').trim();
    const shopRoot = (dependencies.resolveShopRoot || resolveShopRoot)(dataDepartmentRoot, { shopId: sellerId, shopName });
    const frozenA = structuredClone(a); const frozenB = structuredClone(b); const frozenShop = structuredClone(identified);
    const requestId = String((dependencies.requestIdFactory || crypto.randomUUID)());
    if (!requestId) fail('request_id_invalid');
    const runContext = deepFreeze({
      schema_version: 'run_context_v1', request_id: requestId, shop_ref: parsed.shop_ref,
      collection_date: collectionDate, collection_timezone: 'Asia/Manila',
      shop_id: sellerId, shop_name: shopName, provider_id: identified.provider_id, shop_type: identified.shop_type,
      browser_id: String(a.browser_id), seller_id: sellerId,
      shop_code: identity.shop_code, seller_type: identity.seller_type, business_type: identity.business_type,
      shop_region: identity.shop_region, region_code: identity.region_code, seller_hostname: identified.seller_hostname,
      advertiser_id: advertiser.advertiser_id, advertiser_name: advertiser.advertiser_name,
      advertiser_currency: advertiser.advertiser_currency,
      business_center_id: advertiser.business_center_id,
      campaign_ref: parsed.campaign_ref, product_ref: parsed.product_ref,
      campaign_id: null, product_id: null,
      start_date: parsed.start_date, end_date: parsed.end_date,
      report_ids: [...parsed.report_ids], shop_root: shopRoot,
      a: frozenA, b: frozenB, shop: frozenShop,
    });
    return { runContext, browser, browserContext, close };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = {
  IDENTITY_PATH, ONBOARD_PATH, createRunSession, deepFreeze, parseRunRequest,
  readAuthoritativeAdvertiser, readAuthoritativeShopIdentity,
};
