'use strict';

const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { getPath, json, writeArtifact } = require('../../common/shop-api-v3');

const REPORT_ID = 'shop_product_growth_opportunity_snapshot';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function digits(value) { return /^\d+$/u.test(String(value || '')); }
function endpoint(value) { const candidate = String(value || ''); return /^\/[a-z0-9_/-]+$/u.test(candidate) && !candidate.includes('//') && !candidate.includes('..'); }
function fieldPath(value) { return Array.isArray(value) && value.length > 0 && value.every((part) => text(part) || Number.isInteger(part)); }
function httpsOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; } }
function activePage(page, origin) { try { const url = new URL(page.url()); return url.origin === origin && !/(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }

function validateSpec(spec, providerSpec, options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('shop_product_growth_spec_invalid'); }
  const contract = providerSpec?.api_contract; const fields = contract?.request_fields;
  if (spec?.report_id !== REPORT_ID || spec.no_data_rule !== 'official_api_zero_total'
    || spec.providers?.local !== providerSpec || providerSpec?.transport !== 'seller_page_post'
    || !httpsOrigin(providerSpec?.response_origin) || !object(contract) || contract.method !== 'POST'
    || !endpoint(contract.endpoint_path) || !Number.isInteger(contract.page_size) || contract.page_size < 1
    || !Number.isInteger(contract.stage_id) || !Number.isInteger(contract.page_source) || !object(fields)
    || !['filter','stage','page_size','page','page_source'].every((key) => text(fields[key]))
    || new Set(Object.values(fields)).size !== Object.values(fields).length
    || contract.pagination !== 'one_based_page_with_total' || !fieldPath(contract.record_path)
    || !fieldPath(contract.record_key_path) || !fieldPath(contract.total_path)
    || !Number.isInteger(contract.request_timeout_ms) || contract.request_timeout_ms < 1
    || !Number.isInteger(contract.max_pages) || contract.max_pages < 1) fail('shop_product_growth_spec_invalid');
  return spec;
}

function assertSession(context) {
  if (!context.browser?.isConnected?.()) fail('browser_disconnected');
  if (!context.browserContext || !context.browser.contexts?.().includes(context.browserContext)) fail('browser_context_missing');
  if (!context.browserContext.pages().includes(context.page)) fail('seller_page_missing');
  if (!activePage(context.page, context.origin)) fail('seller_origin_mismatch');
}

function assertFailureSession(input, dependencies) {
  if (!dependencies.browser?.isConnected?.()) fail('browser_disconnected');
  if (!dependencies.browserContext || !dependencies.browser.contexts?.().includes(dependencies.browserContext)) fail('browser_context_missing');
  let origin; try { origin = new URL(input?.b?.seller_page_url).origin; } catch { return; }
  const pages = dependencies.browserContext.pages?.() || [];
  if (pages.some((page) => activePage(page, origin))) return;
  if (pages.some((page) => { try { const url = new URL(page.url()); return url.origin === origin && /(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } })) fail('seller_login_page');
  fail('seller_origin_mismatch');
}

function parsePage(body, contract) {
  const products = getPath(body, contract.record_path); const total = getPath(body, contract.total_path);
  if (!Array.isArray(products) || !Number.isInteger(total) || total < 0) fail('shop_product_growth_shape_mismatch');
  return { products, total };
}

function rows(products, contract) {
  return products.map((product) => [String(getPath(product, contract.record_key_path)), json(product)]);
}

async function post(context, providerSpec, contract, body) {
  assertSession(context); const target = new URL(contract.endpoint_path, providerSpec.response_origin); let response;
  try { response = await context.page.request.fetch(target.href, { method: contract.method, headers: { 'content-type':'application/json' }, data: body, timeout: contract.request_timeout_ms, failOnStatusCode: false }); }
  catch { assertSession(context); fail('shop_product_growth_transport_error'); }
  assertSession(context); if ([401,403].includes(response.status())) fail('transport_login_required'); if (response.status() !== 200) fail('shop_product_growth_http_error');
  const final = new URL(response.url()); if (final.origin !== providerSpec.response_origin || final.pathname !== contract.endpoint_path) fail('seller_origin_mismatch');
  let parsed; try { parsed = JSON.parse((await response.body()).toString('utf8')); } catch { fail('shop_product_growth_shape_mismatch'); }
  if (!object(parsed) || parsed.code !== 0) fail('shop_product_growth_api_error'); return parsed;
}

async function runInner(input, dependencies = {}) {
  if (input?.shop?.provider_id !== 'local') fail('report_provider_unsupported');
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  if (!object(input.b) || !object(input.shop) || !digits(input.shop.seller_id) || !dependencies.browser || !dependencies.browserContext) fail('shop_product_growth_input_invalid');
  const outputDir = path.resolve(String(input.outputDir || '')); const outputStat = fs.statSync(outputDir, { throwIfNoEntry:false });
  if (outputStat && (!outputStat.isDirectory() || fs.readdirSync(outputDir).length)) fail('output_directory_invalid');
  let origin; try { origin = new URL(input.b.seller_page_url).origin; } catch { fail('provider_binding_invalid'); }
  if (origin !== input.providerSpec.response_origin) fail('provider_binding_invalid');
  const page = dependencies.browserContext.pages().find((candidate) => activePage(candidate, origin)); if (!page) fail('seller_page_missing');
  const context = { browser: dependencies.browser, browserContext: dependencies.browserContext, page, origin };
  const contract = input.providerSpec.api_contract; const products = []; const ids = new Set(); let total = null;
  for (let pageNumber = 1; pageNumber <= contract.max_pages; pageNumber += 1) {
    const fields = contract.request_fields; const body = { [fields.filter]:{}, [fields.stage]:contract.stage_id, [fields.page_size]:contract.page_size, [fields.page]:pageNumber, [fields.page_source]:contract.page_source };
    const observed = parsePage(await post(context, input.providerSpec, contract, body), contract);
    if (total === null) total = observed.total; if (total !== observed.total) fail('shop_product_growth_pagination_incomplete');
    for (const product of observed.products) { const id = String(getPath(product, contract.record_key_path) || ''); if (!digits(id) || ids.has(id)) fail('shop_product_growth_pagination_incomplete'); ids.add(id); products.push(product); }
    if (products.length >= total) break; if (!observed.products.length) fail('shop_product_growth_pagination_incomplete');
  }
  if (products.length !== total) fail('shop_product_growth_pagination_incomplete');
  const artifact = writeArtifact(input, { logical_table:'products', headers:input.reportSpec.headers }, rows(products, contract), products.length ? 'success' : 'no_data', { no_data_evidence: products.length ? undefined : input.reportSpec.no_data_rule });
  const { logical_table:_logicalTable, ...single } = artifact;
  return { ...single, report_id:REPORT_ID, shop_id:String(input.shop.seller_id), seller_id:String(input.shop.seller_id), provider_id:input.shop.provider_id };
}

async function run(input, dependencies = {}) { try { return await runInner(input, dependencies); } catch (error) { if (dependencies.browser) assertFailureSession(input, dependencies); throw error; } }

module.exports = { run, validateSpec };
