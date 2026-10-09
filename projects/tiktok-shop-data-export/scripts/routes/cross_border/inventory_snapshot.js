'use strict';

const { validateReportSpec } = require('../../common/md-spec-validator');
const { waitForCapture } = require('../../common/wait_for_capture');
const { field, validStockListBody, writeInventoryWorkbook } = require('../common/inventory_snapshot');

const PROVIDER_ID = 'cross_border';
const REPORT_ID = 'inventory_snapshot';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function validResponseOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && value === url.origin; } catch { return false; } }
function validateSpec(spec, providerSpec = spec?.providers?.[PROVIDER_ID], options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('inventory_report_spec_invalid'); }
  const rules = providerSpec;
  if (spec?.report_id !== REPORT_ID || rules !== spec.providers?.[PROVIDER_ID]
    || ![rules?.entry_path, rules?.endpoint_path].every((value) => typeof value === 'string' && value.startsWith('/'))
    || !validResponseOrigin(rules?.response_origin)
    || ![rules?.seller_query, rules?.next_page_selector, rules?.disabled_class_marker, rules?.sheet_name].every((value) => typeof value === 'string' && value)
    || !rules?.response_fields
    || ![rules.navigation_timeout_ms, rules.capture_timeout_ms, rules.poll_interval_ms, rules.page_timeout_ms].every((value) => Number.isInteger(value) && value > 0)) fail('inventory_report_spec_invalid');
  return rules;
}
function inventorySellerId(input) { const sellerId = String(input.shop?.seller_id || ''); if (!/^\d+$/.test(sellerId)) fail('inventory_identity_unavailable'); return sellerId; }
function matchesInventoryResponse(response, rules) { const url = new URL(response.url()); return url.origin === rules.response_origin && url.pathname === rules.endpoint_path; }

async function collectAllSkus(page, firstResponse, sellerId, rules) {
  const expectedTotal = field(firstResponse.body, 'total', rules);
  if (!validStockListBody(firstResponse.body, rules)) fail('inventory_incomplete');
  const byId = new Map(); const addPage = (item) => {
    const requestSellerId = new URL(item.request_url).searchParams.get(rules.seller_query); const total = field(item.body, 'total', rules); const skus = field(item.body, 'records', rules);
    if (requestSellerId !== sellerId) fail('inventory_shop_identity_mismatch');
    if (field(item.body, 'success_code', rules) !== 0 || !validStockListBody(item.body, rules) || total !== expectedTotal) fail('inventory_incomplete');
    for (const sku of skus) { const productId = String(field(sku, 'product_id', rules) || '').trim(); const skuId = String(field(sku, 'sku_id', rules) || '').trim(); if (!productId || !skuId || byId.has(skuId)) fail('inventory_incomplete'); byId.set(skuId, sku); }
  };
  addPage(firstResponse); const firstPageSize = field(firstResponse.body, 'records', rules).length;
  if (expectedTotal === 0) { if (firstPageSize !== 0) fail('inventory_incomplete'); return []; }
  if (!firstPageSize) fail('inventory_incomplete');
  const maxPages = Math.ceil(expectedTotal / firstPageSize) + 1;
  for (let pageNumber = 2; byId.size < expectedTotal && pageNumber <= maxPages; pageNumber += 1) {
    const next = page.locator(rules.next_page_selector); if (await next.count() !== 1 || (await next.getAttribute('class') || '').includes(rules.disabled_class_marker)) fail('inventory_incomplete');
    const pending = page.waitForResponse((response) => matchesInventoryResponse(response, rules), { timeout: rules.page_timeout_ms }); await next.click(); const response = await pending; const body = await response.json().catch(() => null); addPage({ request_url: response.url(), body });
  }
  if (byId.size !== expectedTotal) fail('inventory_incomplete'); return [...byId.values()];
}

async function run(input, dependencies = {}) {
  const rules = validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  const sellerId = inventorySellerId(input); const browser = dependencies.browser; const context = dependencies.browserContext;
  if (!browser || typeof browser.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  if (!context || typeof browser.contexts !== 'function' || !browser.contexts().includes(context)) fail('browser_context_missing');
  const origin = new URL(input.b.seller_page_url).origin; const pages = context.pages();
  const page = pages.find((item) => item.url() === input.b.seller_page_url) || pages.find((item) => { try { return new URL(item.url()).origin === origin; } catch { return false; } });
  if (!page) fail('seller_page_missing');
  const capturedAt = (dependencies.clock || (() => new Date()))().toISOString(); const lists = [];
  const listener = async (response) => { try { if (matchesInventoryResponse(response, rules)) lists.push({ request_url: response.url(), body: await response.json().catch(() => null) }); } catch { /* malformed responses fail below */ } };
  page.on('response', listener);
  try {
    await page.goto(new URL(rules.entry_path, origin).href, { waitUntil: 'domcontentloaded', timeout: rules.navigation_timeout_ms });
    await (dependencies.waitForCapture || waitForCapture)(page, () => { const codeZero = lists.filter((item) => field(item.body, 'success_code', rules) === 0); if (codeZero.some((item) => !validStockListBody(item.body, rules))) fail('inventory_incomplete'); return codeZero.length > 0; }, { timeoutMs: rules.capture_timeout_ms, pollMs: rules.poll_interval_ms });
  } finally { page.off('response', listener); }
  if (lists.some((item) => new URL(item.request_url).searchParams.get(rules.seller_query) !== sellerId)) fail('inventory_shop_identity_mismatch');
  const successfulLists = lists.filter((item) => field(item.body, 'success_code', rules) === 0); const response = successfulLists[0];
  if (!response) fail('inventory_source_unavailable');
  const firstTotal = field(response.body, 'total', rules);
  if (successfulLists.some((item) => field(item.body, 'total', rules) !== firstTotal || (firstTotal === 0 && field(item.body, 'records', rules).length !== 0))) fail('inventory_incomplete');
  return writeInventoryWorkbook(input, await collectAllSkus(page, response, sellerId, rules), capturedAt, rules);
}

module.exports = { run, validateSpec };
