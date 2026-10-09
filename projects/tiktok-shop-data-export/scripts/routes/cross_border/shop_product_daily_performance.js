'use strict';

const { validateReportSpec } = require('../../common/md-spec-validator');
const { aggregate, apiBody, borrowedPage, fail, getPath, json, without, writeArtifact } = require('../../common/shop-api-v3');
const { payload } = require('../common/shop_product_daily_performance_v3');

const REPORT_ID = 'shop_product_daily_performance';
const TABLES = ['total', 'self_live', 'self_video', 'affiliate_content', 'product_card'];

function validateSpec(spec, options = {}) {
  try {
    validateReportSpec(spec, options);
    const provider = spec.providers?.cross_border; const contract = provider?.api_contract; const retry = provider?.retry_policy;
    if (spec.report_id !== REPORT_ID
      || spec.owner_scope !== 'shop' || spec.time_semantics !== 'requested_range' || spec.output_granularity !== 'request_range'
      || spec.source_type !== 'official_api' || spec.success_output_type !== 'generated_xlsx'
      || spec.no_data_output_type !== 'generated_xlsx' || spec.no_data_rule !== 'official_api_zero_total'
      || JSON.stringify(spec.required_variables) !== JSON.stringify(['shop', 'start_date', 'end_date'])
      || JSON.stringify(spec.logical_tables.map((item) => item.logical_table)) !== JSON.stringify(TABLES)
      || !provider || provider.transport !== 'page_context_fetch'
      || ![provider.entry_path, provider.endpoint_path].every((value) => typeof value === 'string' && /^\/[a-z0-9_/-]+$/u.test(value))
      || !Number.isInteger(provider.request_timeout_ms) || provider.request_timeout_ms < 1
      || !Number.isInteger(contract?.page_size) || contract.page_size < 1 || !Number.isInteger(contract?.max_pages) || contract.max_pages < 1
      || contract.date_end !== 'requested_end_plus_one_day'
      || JSON.stringify(contract.channels) !== JSON.stringify(TABLES.map((logical_table, type) => ({ type, logical_table })))
      || JSON.stringify(contract.record_path) !== JSON.stringify(['data','items'])
      || JSON.stringify(contract.record_key_path) !== JSON.stringify(['meta','product_id'])
      || JSON.stringify(contract.pagination_path) !== JSON.stringify(['data','list_control','next_pagination'])
      || !contract.request_fields || !['root','time','start','end','search','channel','list_control','pagination','page','size','rules'].every((field) => typeof contract.request_fields[field] === 'string' && contract.request_fields[field])
      || !contract.pagination_fields || !['total','has_more'].every((field) => typeof contract.pagination_fields[field] === 'string' && contract.pagination_fields[field])
      || !Array.isArray(contract.rules) || !contract.rules.length
      || retry?.operation_class !== 'idempotent_read' || retry.max_total_attempts !== 1 || retry.identity_and_contract_failures_retryable !== false) fail('shop_product_daily_spec_invalid');
    let responseOrigin; try { responseOrigin = new URL(provider.response_origin); } catch { fail('shop_product_daily_spec_invalid'); }
    if (responseOrigin.protocol !== 'https:' || responseOrigin.origin !== provider.response_origin) fail('shop_product_daily_spec_invalid');
  } catch (error) { if (error.code === 'shop_product_daily_spec_invalid') throw error; fail('shop_product_daily_spec_invalid'); }
  return spec;
}
function providerRules(spec, providerSpec) { if (spec.providers?.cross_border !== providerSpec) fail('provider_binding_invalid'); return providerSpec; }
async function request(live, input, dependencies) {
  if (dependencies.request) return dependencies.request(live, input);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('shop_product_daily_transport_timeout'), { code:'shop_product_daily_transport_timeout' })), input.timeout_ms); });
  const pending = live.page.evaluate(async ({ url, body, timeoutMs }) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { const response = await fetch(url, { method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:controller.signal }); return { http_status:response.status, body:await response.json().catch(() => null) }; }
    finally { clearTimeout(timer); }
  }, { url:input.url, body:input.body, timeoutMs:input.timeout_ms });
  try { return await Promise.race([pending, timeout]); } finally { clearTimeout(timer); }
}
async function sourceUrl(live, rules, dependencies) {
  const matchesSource = (value) => { try { const url = new URL(value); return url.origin === rules.response_origin && url.pathname === rules.endpoint_path; } catch { return false; } };
  if (dependencies.seedUrl) { if (!matchesSource(dependencies.seedUrl)) fail('shop_product_daily_source_origin_mismatch'); return dependencies.seedUrl; }
  const pending = live.page.waitForRequest((request) => {
    try { return request.method() === 'POST' && matchesSource(request.url()); } catch { return false; }
  }, { timeout: rules.request_timeout_ms });
  try {
    const current = new URL(live.page.url());
    const entry = new URL(rules.entry_path, live.origin);
    if (current.origin === entry.origin && current.pathname === entry.pathname) {
      await live.page.reload({ waitUntil: 'domcontentloaded', timeout: rules.request_timeout_ms });
    } else {
      await live.page.goto(entry.toString(), { waitUntil: 'domcontentloaded', timeout: rules.request_timeout_ms });
    }
  }
  catch { pending.catch(() => {}); if (live.browser && !live.browser.isConnected()) fail('browser_disconnected'); fail('shop_product_daily_navigation_error'); }
  let request;
  try { request = await pending; }
  catch (error) {
    fail(error?.name === 'TimeoutError' ? 'shop_product_daily_source_capture_timeout' : 'shop_product_daily_source_capture_error');
  }
  try { const url = request.url(); if (!matchesSource(url)) fail('shop_product_daily_source_origin_mismatch'); return url; } catch (error) { if (error?.code) throw error; fail('shop_product_daily_source_capture_error'); }
}
async function collect(live, spec, rules, startDate, endDate, channel, dependencies, endpoint) {
  const contract = rules.api_contract;
  const items = []; let total = null;
  for (let page = 0; page < contract.max_pages; page += 1) {
    let result;
    try { result = await request(live, { url: endpoint, body: payload(contract, startDate, endDate, channel, page), timeout_ms:rules.request_timeout_ms }, dependencies); }
    catch (error) { if (!live.browser?.isConnected?.()) fail('browser_disconnected'); if (['browser_disconnected', 'shop_product_daily_transport_timeout'].includes(error?.code)) throw error; fail('shop_product_daily_transport_error'); }
    if (result?.http_status !== 200) fail('shop_product_daily_http_error');
    if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) fail('shop_product_daily_shape_mismatch');
    if (result.body.code === 10000) fail('shop_product_daily_api_challenge');
    const body = apiBody(result, 'shop_product_daily_api_error'); const pagination = getPath(body,contract.pagination_path);
    const fields=contract.pagination_fields; const observedTotal=pagination?.[fields.total]; const hasMore=pagination?.[fields.has_more]; const rows = getPath(body,contract.record_path) ?? (observedTotal === 0 ? [] : null);
    if (!Array.isArray(rows) || !Number.isInteger(observedTotal) || observedTotal < 0 || typeof hasMore !== 'boolean') fail('shop_product_daily_shape_mismatch');
    if (total === null) total = observedTotal;
    if (total !== observedTotal) fail('shop_product_daily_pagination_incomplete');
    items.push(...rows);
    if (!hasMore) break;
  }
  const ids = items.map((item) => String(getPath(item,contract.record_key_path) || ''));
  if (total === null || items.length !== total || ids.some((id) => !/^\d+$/u.test(id)) || new Set(ids).size !== ids.length) fail('shop_product_daily_pagination_incomplete');
  return { total, items };
}
async function run(input, dependencies = {}) {
  if (input?.shop?.provider_id !== 'cross_border') fail('report_provider_unsupported');
  validateSpec(input.reportSpec, { skillRoot: dependencies.skillRoot });
  const rules = providerRules(input.reportSpec, input.providerSpec); const contract = rules.api_contract;
  const live = borrowedPage(input, dependencies); const endpoint = await sourceUrl(live, rules, dependencies); const artifacts = [];
  const total = await collect(live, input.reportSpec, rules, input.startDate, input.endDate, contract.channels[0], dependencies, endpoint);
  const collections = [total];
  if (total.total > 0) {
    for (const channel of contract.channels.slice(1)) collections.push(await collect(live, input.reportSpec, rules, input.startDate, input.endDate, channel, dependencies, endpoint));
    const universe = new Set(total.items.map((item) => String(getPath(item,contract.record_key_path))));
    if (collections.slice(1).some((collection) => collection.items.some((item) => !universe.has(String(getPath(item,contract.record_key_path)))))) fail('shop_product_daily_channel_universe_mismatch');
  } else {
    while (collections.length < TABLES.length) collections.push({ total: 0, items: [] });
  }
  for (let index = 0; index < collections.length; index += 1) {
    const table = input.reportSpec.logical_tables[index]; const collection = collections[index];
    const metaKey=contract.record_key_path[0]; const rows = collection.items.map((item) => [input.startDate, input.endDate, String(getPath(item,contract.record_key_path)), json(item[metaKey]), json(without(item, [metaKey]))]);
    artifacts.push(writeArtifact(input, table, rows, rows.length ? 'success' : 'no_data', { no_data_evidence: rows.length ? undefined : 'official_api_zero_total' }));
  }
  return { status: aggregate(artifacts), report_id: REPORT_ID, shop_id: live.sellerId, seller_id: live.sellerId, artifacts };
}

module.exports = { collect, payload, run, sourceUrl, validateSpec };
