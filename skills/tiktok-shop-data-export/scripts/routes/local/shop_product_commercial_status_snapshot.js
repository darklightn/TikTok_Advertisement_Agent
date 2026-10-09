'use strict';

const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { aggregate, getPath, writeArtifact } = require('../../common/shop-api-v3');
const { productRow, skuRow } = require('../common/shop_product_commercial_status_snapshot_v3');

const REPORT_ID = 'shop_product_commercial_status_snapshot';
const PROVIDER_ID = 'local';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function endpoint(value) { const candidate = String(value || ''); return /^\/[a-z0-9_/-]+$/u.test(candidate) && !candidate.includes('//') && !candidate.includes('..'); }
function fieldPath(value) { return Array.isArray(value) && value.length > 0 && value.every((item) => text(item) || Number.isInteger(item)); }
function httpsOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; } }
function activePage(page, origin) { try { const url = new URL(page.url()); return url.origin === origin && !/(?:login|signin|passport)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }
function fields(value, names) { return object(value) && names.every((name) => text(value[name])) && new Set(names.map((name) => value[name])).size === names.length; }

function validateSpec(spec, providerSpec, options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('shop_product_commercial_spec_invalid'); }
  const contract = providerSpec?.api_contract;
  if (spec?.report_id !== REPORT_ID || !Array.isArray(spec.logical_tables) || !['products', 'skus'].every((name) => { const table = spec.logical_tables.find((item) => item.logical_table === name); return table && table.headers.at(-1) === 'currency'; })
    || !object(spec.generated_currency) || spec.generated_currency.source_kind !== 'official_record_symbol' || spec.generated_currency.currency_symbol !== '₱' || spec.generated_currency.currency_code !== 'PHP'
    || spec.no_data_rule !== 'official_api_zero_total' || spec.providers?.local !== providerSpec || providerSpec?.transport !== 'seller_entry_capture_seed_renderer_get_lifecycle_tabs'
    || !httpsOrigin(providerSpec?.response_origin) || !object(contract) || !endpoint(contract.entry_path) || !endpoint(contract.endpoint_path) || contract.method !== 'GET'
    || !Number.isInteger(contract.page_size) || contract.page_size < 1 || !Number.isInteger(contract.sku_number) || contract.sku_number < 1
    || contract.pagination !== 'one_based_page_per_tab_with_total_product_count' || !Array.isArray(contract.lifecycle_tabs) || !contract.lifecycle_tabs.length
    || contract.lifecycle_tabs.some((tab) => !Number.isInteger(tab.tab_id) || !text(tab.status)) || new Set(contract.lifecycle_tabs.map((tab) => tab.tab_id)).size !== contract.lifecycle_tabs.length
    || !fields(contract.query_fields, ['tab', 'page', 'page_size', 'sku_number']) || !fieldPath(contract.record_path) || !fieldPath(contract.product_key_path)
    || !fieldPath(contract.sku_list_path) || contract.sku_list_path.length !== 1 || !fieldPath(contract.sku_key_path) || !text(contract.sku_total_field)
    || !fieldPath(contract.total_path) || !fieldPath(contract.response_page_path) || !fieldPath(contract.response_page_size_path)
    || !object(contract.query_constants) || Object.values(contract.query_constants).some((value) => !['string', 'number', 'boolean'].includes(typeof value))
    || !Array.isArray(contract.seller_query_names) || !contract.seller_query_names.length || contract.seller_query_names.some((name) => !text(name))
    || new Set(contract.seller_query_names).size !== contract.seller_query_names.length || !Number.isInteger(contract.request_timeout_ms) || contract.request_timeout_ms < 1
    || !Number.isInteger(contract.max_pages) || contract.max_pages < 1) fail('shop_product_commercial_spec_invalid');
  return spec;
}

function assertSession(live) {
  if (!live.browser?.isConnected?.()) fail('browser_disconnected');
  if (!live.context || !live.browser.contexts?.().includes(live.context)) fail('browser_context_missing');
  if (!live.context.pages().includes(live.page)) fail('seller_page_missing');
  if (!activePage(live.page, live.sellerOrigin)) fail('seller_origin_mismatch');
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

function validSeed(response, provider, sellerId) {
  let url; try { url = new URL(response.url()); } catch { return false; }
  const contract = provider.api_contract;
  return response.request().method() === contract.method && url.origin === provider.response_origin && url.pathname === contract.endpoint_path
    && contract.seller_query_names.every((name) => url.searchParams.get(name) === sellerId);
}

async function captureSeed(live, provider) {
  const contract = provider.api_contract;
  const pending = live.page.waitForResponse((response) => validSeed(response, provider, live.sellerId), { timeout: contract.request_timeout_ms });
  try {
    await live.page.goto(`${provider.response_origin}${contract.entry_path}`, { waitUntil: 'domcontentloaded', timeout: contract.request_timeout_ms });
    const response = await pending;
    assertSession(live);
    return response.url();
  } catch {
    assertSession(live);
    fail('shop_product_commercial_seed_unavailable');
  }
}

function pageUrl(seed, provider, sellerId, tab, pageNumber) {
  let url; try { url = new URL(seed); } catch { fail('shop_product_commercial_seed_invalid'); }
  const contract = provider.api_contract;
  if (!validSeed({ url: () => url.href, request: () => ({ method: () => contract.method }) }, provider, sellerId)) fail('shop_product_commercial_seed_invalid');
  const fieldsMap = contract.query_fields;
  const values = { ...contract.query_constants, [fieldsMap.tab]: tab.tab_id, [fieldsMap.page]: pageNumber, [fieldsMap.page_size]: contract.page_size, [fieldsMap.sku_number]: contract.sku_number };
  for (const name of contract.seller_query_names) values[name] = sellerId;
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
  return url.href;
}

function verifyUrl(value, provider, sellerId, tab, pageNumber) {
  let url; try { url = new URL(value); } catch { fail('shop_product_commercial_api_error'); }
  const contract = provider.api_contract; const fieldsMap = contract.query_fields;
  if (url.origin !== provider.response_origin || url.pathname !== contract.endpoint_path) fail('seller_origin_mismatch');
  const expected = { ...contract.query_constants, [fieldsMap.tab]: tab.tab_id, [fieldsMap.page]: pageNumber, [fieldsMap.page_size]: contract.page_size, [fieldsMap.sku_number]: contract.sku_number };
  for (const name of contract.seller_query_names) expected[name] = sellerId;
  if (Object.entries(expected).some(([key, value]) => url.searchParams.get(key) !== String(value))) fail('provider_binding_invalid');
}

async function getPage(live, provider, url, tab, pageNumber) {
  assertSession(live);
  const timeoutMs = provider.api_contract.request_timeout_ms;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('renderer_timeout')), timeoutMs); });
  let response;
  try {
    const pending = live.page.evaluate(async ({ requestUrl, requestMethod, requestTimeoutMs }) => {
      const controller = new AbortController(); const abortTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try { const result = await fetch(requestUrl, { method: requestMethod, credentials: 'include', signal: controller.signal }); return { final_url: result.url, http_status: result.status, body: await result.json().catch(() => null) }; }
      finally { clearTimeout(abortTimer); }
    }, { requestUrl: url, requestMethod: provider.api_contract.method, requestTimeoutMs: timeoutMs });
    response = await Promise.race([pending, timeout]);
  } catch { assertSession(live); fail('shop_product_commercial_transport_error'); }
  finally { clearTimeout(timer); }
  assertSession(live);
  if ([401, 403].includes(response?.http_status)) fail('transport_login_required');
  if (response?.http_status !== 200) fail('shop_product_commercial_api_error');
  verifyUrl(response?.final_url, provider, live.sellerId, tab, pageNumber);
  if (!object(response?.body) || response.body.code !== 0) fail('shop_product_commercial_api_error');
  return response.body;
}

async function runInner(input, dependencies = {}) {
  if (input?.shop?.provider_id !== PROVIDER_ID) fail('report_provider_unsupported');
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  if (!object(input.b) || !object(input.shop) || !digits(input.shop.seller_id) || !dependencies.browser || !dependencies.browserContext) fail('shop_product_commercial_input_invalid');
  const outputDir = path.resolve(String(input.outputDir || '')); const stat = fs.statSync(outputDir, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || fs.readdirSync(outputDir).length)) fail('output_directory_invalid');
  let sellerOrigin; try { sellerOrigin = new URL(input.b.seller_page_url).origin; } catch { fail('provider_binding_invalid'); }
  if (sellerOrigin !== input.providerSpec.response_origin) fail('seller_origin_mismatch');
  const page = dependencies.browserContext.pages().find((candidate) => activePage(candidate, sellerOrigin));
  if (!page) fail('seller_page_missing');
  const live = { browser: dependencies.browser, context: dependencies.browserContext, page, sellerOrigin, sellerId: String(input.shop.seller_id) };
  const provider = input.providerSpec; const contract = provider.api_contract; const seed = await captureSeed(live, provider);
  const products = []; const skus = []; const productIds = new Set(); const skuIds = new Set();
  for (const tab of contract.lifecycle_tabs) {
    let total = null; let collected = 0;
    for (let pageNumber = 1; pageNumber <= contract.max_pages; pageNumber += 1) {
      const body = await getPage(live, provider, pageUrl(seed, provider, live.sellerId, tab, pageNumber), tab, pageNumber);
      const observedTotal = getPath(body, contract.total_path); const observedPage = getPath(body, contract.response_page_path); const observedPageSize = getPath(body, contract.response_page_size_path);
      const rows = getPath(body, contract.record_path) ?? (observedTotal === 0 ? [] : null);
      if (!Number.isInteger(observedTotal) || observedTotal < 0 || observedPage !== pageNumber || observedPageSize !== contract.page_size || !Array.isArray(rows)) fail('shop_product_commercial_shape_mismatch');
      if (total === null) total = observedTotal;
      if (total !== observedTotal) fail('shop_product_commercial_pagination_incomplete');
      for (const product of rows) {
        const productId = String(getPath(product, contract.product_key_path) || ''); const skuList = getPath(product, contract.sku_list_path); const skuTotal = product?.[contract.sku_total_field];
        if (!digits(productId) || productIds.has(productId) || !Number.isInteger(skuTotal) || !Array.isArray(skuList) || skuList.length !== skuTotal) fail('shop_product_commercial_identity_incomplete');
        productIds.add(productId); products.push(productRow(tab, productId, product, contract, input.reportSpec.generated_currency.currency_code));
        for (const sku of skuList) { const skuId = String(getPath(sku, contract.sku_key_path) || ''); if (!digits(skuId) || skuIds.has(skuId)) fail('shop_product_commercial_identity_incomplete'); skuIds.add(skuId); skus.push(skuRow(tab, productId, skuId, sku, input.reportSpec.generated_currency.currency_code)); }
      }
      collected += rows.length;
      if (collected >= total) break;
      if (!rows.length) fail('shop_product_commercial_pagination_incomplete');
    }
    if (collected !== total) fail('shop_product_commercial_pagination_incomplete');
  }
  const artifacts = [
    writeArtifact(input, input.reportSpec.logical_tables.find((table) => table.logical_table === 'products'), products, products.length ? 'success' : 'no_data', { no_data_evidence: products.length ? undefined : input.reportSpec.no_data_rule }),
    writeArtifact(input, input.reportSpec.logical_tables.find((table) => table.logical_table === 'skus'), skus, skus.length ? 'success' : 'no_data', { no_data_evidence: skus.length ? undefined : input.reportSpec.no_data_rule }),
  ];
  return { status: aggregate(artifacts), report_id: REPORT_ID, shop_id: live.sellerId, seller_id: live.sellerId, provider_id: PROVIDER_ID, artifacts };
}

async function run(input, dependencies = {}) { try { return await runInner(input, dependencies); } catch (error) { if (dependencies.browser) assertFailureSession(input, dependencies); throw error; } }

module.exports = { pageUrl, run, validateSpec, verifyUrl };
