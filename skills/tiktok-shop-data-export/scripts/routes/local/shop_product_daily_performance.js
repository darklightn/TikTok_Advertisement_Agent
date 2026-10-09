'use strict';

const { validateReportSpec } = require('../../common/md-spec-validator');
const { aggregate, apiBody, borrowedPage, fail, getPath, json, without, writeArtifact } = require('../../common/shop-api-v3');

const REPORT_ID = 'shop_product_daily_performance';
const TABLES = ['total', 'self_live', 'self_video', 'affiliate_content', 'product_card'];

function nextDate(value) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }
function payload(contract, startDate, endDate, channel, page) {
  const fields = contract.request_fields;
  return { [fields.root]: { [fields.time]: { [fields.start]:startDate, [fields.end]:nextDate(endDate) }, [fields.search]: { [fields.channel]:channel.type }, [fields.list_control]: { [fields.pagination]: { [fields.page]:page, [fields.size]:contract.page_size }, [fields.rules]:contract.rules } } };
}
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function httpsOrigin(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; } }
function endpoint(value) { return typeof value === 'string' && /^\/[a-z0-9_/-]+$/u.test(value); }

function validateSpec(spec, providerSpec, options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('shop_product_daily_spec_invalid'); }
  const provider = providerSpec; const contract = provider?.api_contract; const retry = provider?.retry_policy;
  if (spec?.report_id !== REPORT_ID || spec.no_data_rule !== 'official_api_zero_total'
    || spec.time_semantics !== 'requested_range' || spec.output_granularity !== 'request_range'
    || spec.providers?.local !== provider || provider?.transport !== 'page_context_fetch'
    || !httpsOrigin(provider.response_origin) || !endpoint(provider.entry_path) || !endpoint(provider.endpoint_path)
    || !Array.isArray(provider.seller_query_names) || provider.seller_query_names.length !== 2
    || provider.seller_query_names.some((value) => !text(value)) || new Set(provider.seller_query_names).size !== 2 || !text(provider.pagination_next_page_field)
    || !Number.isInteger(provider.request_timeout_ms) || provider.request_timeout_ms < 1
    || !Number.isInteger(contract?.page_size) || contract.page_size < 1 || !Number.isInteger(contract.max_pages) || contract.max_pages < 1
    || contract.date_end !== 'requested_end_plus_one_day'
    || JSON.stringify(contract.channels) !== JSON.stringify(TABLES.map((logical_table, type) => ({ type, logical_table })))
    || !Array.isArray(contract.record_path) || !contract.record_path.length || !Array.isArray(contract.record_key_path) || !contract.record_key_path.length
    || !Array.isArray(contract.pagination_path) || !contract.pagination_path.length
    || !contract.request_fields || !['root','time','start','end','search','channel','list_control','pagination','page','size','rules'].every((field) => text(contract.request_fields[field]))
    || !contract.pagination_fields || !['total','has_more'].every((field) => text(contract.pagination_fields[field]))
    || !Array.isArray(contract.rules) || !contract.rules.length || contract.pagination !== 'zero_based_page_with_total_and_has_more'
    || retry?.operation_class !== 'idempotent_read' || retry.max_total_attempts !== 1 || retry.identity_and_contract_failures_retryable !== false) fail('shop_product_daily_spec_invalid');
  return spec;
}

async function request(live, value, dependencies) {
  if (dependencies.request) return dependencies.request(live, value);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('shop_product_daily_transport_timeout'), { code:'shop_product_daily_transport_timeout' })), value.timeout_ms); });
  const pending = live.page.evaluate(async ({ url, body, timeoutMs }) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { const response = await fetch(url, { method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:controller.signal }); return { http_status:response.status, final_url:response.url, body:await response.json().catch(() => null) }; }
    finally { clearTimeout(timer); }
  }, { url:value.url, body:value.body, timeoutMs:value.timeout_ms });
  try { return await Promise.race([pending, timeout]); } finally { clearTimeout(timer); }
}

function endpointUrl(live, rules) {
  if (live.origin !== rules.response_origin) fail('provider_binding_invalid');
  const target = new URL(rules.endpoint_path, rules.response_origin);
  for (const name of rules.seller_query_names) target.searchParams.set(name, live.sellerId);
  return target;
}

async function collect(live, rules, startDate, endDate, channel, dependencies, target) {
  const contract = rules.api_contract; const items = []; const requestedPages = new Set(); let total = null; let page = 0;
  for (let attempt = 0; attempt < contract.max_pages; attempt += 1) {
    if (!Number.isInteger(page) || page < 0 || requestedPages.has(page)) fail('shop_product_daily_pagination_incomplete'); requestedPages.add(page);
    let result;
    try { result = await request(live, { url:target.href, body:payload(contract, startDate, endDate, channel, page), timeout_ms:rules.request_timeout_ms }, dependencies); }
    catch (error) { if (!live.browser?.isConnected?.()) fail('browser_disconnected'); if (error?.code === 'shop_product_daily_transport_timeout') throw error; fail('shop_product_daily_transport_error'); }
    if (result?.http_status !== 200) fail('shop_product_daily_http_error');
    let final; try { final = new URL(result.final_url || target.href); } catch { fail('shop_product_daily_source_origin_mismatch'); }
    if (final.origin !== rules.response_origin || final.pathname !== rules.endpoint_path || rules.seller_query_names.some((name) => final.searchParams.get(name) !== live.sellerId)) fail('shop_product_daily_source_origin_mismatch');
    if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) fail('shop_product_daily_shape_mismatch');
    if (result.body.code === 10000) fail('shop_product_daily_api_challenge');
    const body = apiBody(result, 'shop_product_daily_api_error'); const pagination = getPath(body, contract.pagination_path); const fields = contract.pagination_fields;
    const observedTotal = pagination?.[fields.total]; const hasMore = pagination?.[fields.has_more]; const nextPage = pagination?.[rules.pagination_next_page_field]; const rows = getPath(body, contract.record_path) ?? (observedTotal === 0 ? [] : null);
    if (!Array.isArray(rows) || !Number.isInteger(observedTotal) || observedTotal < 0 || typeof hasMore !== 'boolean' || (hasMore && (!Number.isInteger(nextPage) || nextPage < 0))) fail('shop_product_daily_shape_mismatch');
    if (total === null) total = observedTotal; if (total !== observedTotal) fail('shop_product_daily_pagination_incomplete'); items.push(...rows);
    if (!hasMore) break; page = nextPage;
  }
  const ids = items.map((item) => String(getPath(item, contract.record_key_path) || ''));
  if (total === null || items.length !== total || ids.some((id) => !/^\d+$/u.test(id)) || new Set(ids).size !== ids.length) fail('shop_product_daily_pagination_incomplete');
  return { total, items };
}

async function run(input, dependencies = {}) {
  if (input?.shop?.provider_id !== 'local') fail('report_provider_unsupported');
  validateSpec(input.reportSpec, input.providerSpec, { skillRoot:dependencies.skillRoot });
  const rules = input.providerSpec; const contract = rules.api_contract; const live = borrowedPage(input, dependencies); const target = endpointUrl(live, rules); const artifacts = [];
  const total = await collect(live, rules, input.startDate, input.endDate, contract.channels[0], dependencies, target); const collections = [total];
  if (total.total > 0) {
    for (const channel of contract.channels.slice(1)) collections.push(await collect(live, rules, input.startDate, input.endDate, channel, dependencies, target));
    const universe = new Set(total.items.map((item) => String(getPath(item, contract.record_key_path))));
    if (collections.slice(1).some((collection) => collection.items.some((item) => !universe.has(String(getPath(item, contract.record_key_path)))))) fail('shop_product_daily_channel_universe_mismatch');
  } else while (collections.length < TABLES.length) collections.push({ total:0, items:[] });
  for (let index = 0; index < collections.length; index += 1) {
    const table = input.reportSpec.logical_tables[index]; const collection = collections[index]; const metaKey = contract.record_key_path[0];
    const rows = collection.items.map((item) => [input.startDate, input.endDate, String(getPath(item, contract.record_key_path)), json(item[metaKey]), json(without(item, [metaKey]))]);
    artifacts.push(writeArtifact(input, table, rows, rows.length ? 'success' : 'no_data', { no_data_evidence:rows.length ? undefined : input.reportSpec.no_data_rule }));
  }
  return { status:aggregate(artifacts), report_id:REPORT_ID, shop_id:live.sellerId, seller_id:live.sellerId, provider_id:'local', artifacts };
}

module.exports = { collect, payload, run, validateSpec };
