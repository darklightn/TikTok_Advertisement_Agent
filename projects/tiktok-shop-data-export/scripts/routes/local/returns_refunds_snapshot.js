'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { writeWorkbook } = require('../../common/xlsx_writer');
const { sellerOrigin } = require('../common/inventory_snapshot');

const PROVIDER_ID = 'local';
const REPORT_ID = 'returns_refunds_snapshot';

function fail(code, diagnostics) { throw Object.assign(new Error(code), { code, ...(diagnostics ? { diagnostics } : {}) }); }
function validResponseOrigin(value) { try { return new URL(value).origin === value; } catch { return false; } }
function validateSpec(spec, providerSpec = spec?.providers?.[PROVIDER_ID], options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('returns_refunds_report_spec_invalid'); }
  const rules = providerSpec?.api_contract; const body = rules?.request_body;
  if (spec?.report_id !== REPORT_ID || providerSpec !== spec?.providers?.[PROVIDER_ID]
    || !rules || !validResponseOrigin(rules.response_origin) || rules.method !== 'POST'
    || typeof rules.endpoint_path !== 'string' || !rules.endpoint_path.startsWith('/')
    || !Array.isArray(rules.seller_queries) || !rules.seller_queries.includes(rules.seller_query)
    || rules.seller_queries.some((key) => typeof key !== 'string' || !key)
    || !rules.request_query || Object.values(rules.request_query).some((value) => typeof value !== 'string')
    || !body || body.pagination_type !== 0 || body.offset !== 0 || !Number.isInteger(body.count) || body.count < 1
    || !body.search_condition || !body.component_version || rules.zero_records_policy !== 'missing_or_empty'
    || !rules.response_fields || !rules.card_contract
    || !Number.isInteger(rules.page_response_timeout_ms) || rules.page_response_timeout_ms < 1) fail('returns_refunds_report_spec_invalid');
  return rules;
}
function getPath(value, pathValue) { return (Array.isArray(pathValue) ? pathValue : [pathValue]).reduce((current, key) => current?.[key], value); }
function named(root, name, found = []) { if (!root || typeof root !== 'object') return found; if (root.name === name) found.push(root); for (const value of Object.values(root)) { if (Array.isArray(value)) for (const item of value) named(item, name, found); else if (value && typeof value === 'object') named(value, name, found); } return found; }
function messages(node, rules) { const values = []; const field=rules.card_contract.named_nodes_field; const walk = (value) => { if (!value || typeof value !== 'object') return; if (typeof value.content === 'string') values.push(value.content); if (typeof value[field] === 'string') values.push(value[field].replace(/\{\{[^}]+\}\}/g, '').trim()); for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); } }; walk(node); return [...new Set(values.filter(Boolean))]; }
function timestamp(node, rules) { let result = ''; const field=rules.card_contract.timestamp_field; const walk = (value) => { if (!value || typeof value !== 'object' || result) return; if (value.kvs?.[field]) result = new Date(Number(value.kvs[field]) * 1000).toISOString(); else for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); } }; walk(node); return result; }
function firstText(card, name, rules) { return messages(named(card, name)[0], rules)[0] || ''; }
function fieldValue(card, name, labels, rules) { return messages(named(card, name)[0], rules).find((value) => !labels.includes(value)) || ''; }
function currencyEvidence(cards, rules) { const currencies = new Set(); const contract=rules.card_contract; for (const item of cards) { const biz=item[contract.biz_data]; const card=item[contract.card]||{}; const amount = String(biz?.[contract.return_price] || firstText(card, contract.refund_amount_nodes[0], rules) || '').trim(); if (!amount) continue; if (amount.startsWith(contract.currency_symbol)) currencies.add('PHP'); else fail('returns_refunds_currency_unknown'); } if (currencies.size !== 1) fail('returns_refunds_currency_unknown'); return { currency_code: [...currencies][0], currency_symbol: contract.currency_symbol, currency_source: 'official_amount_symbol', amount_scope: 'all_monetary_fields' }; }
function rowsFor(headers, cards, capturedAt, rules, currencyCode = '') { if (!Array.isArray(headers) || !headers.length) fail('returns_refunds_report_headers_missing'); const contract=rules.card_contract; const nodes=contract.nodes; const rows = [headers.slice()]; for (const item of cards) { const biz=item[contract.biz_data]||{}; const card = item[contract.card] || {}; const evidence = named(card, nodes.evidence)[0]; rows.push([capturedAt, String(biz[contract.main_order_id] || ''), String(biz[contract.reverse_order_id] || ''), timestamp(named(card, nodes.application_time)[0],rules), firstText(card,nodes.reverse_type,rules), fieldValue(card,nodes.reason,contract.reason_labels,rules), fieldValue(card,nodes.note,contract.note_labels,rules), firstText(card,nodes.product,rules), firstText(card,nodes.paid,rules), biz[contract.return_price] || firstText(card,contract.refund_amount_nodes[0],rules), currencyCode, firstText(card,nodes.status,rules), firstText(card,nodes.logistics_status,rules), timestamp(named(card,nodes.logistics_time)[0],rules), named(card,nodes.tags).flatMap((node)=>messages(node,rules)).filter((value) => !(new RegExp(contract.tag_exclusion_pattern,'u')).test(value)).join('; '), Array.isArray(getPath(evidence,contract.evidence_media_path)) ? getPath(evidence,contract.evidence_media_path).length : 0]); } return rows; }
function validatedSellerId(input, failureCode = 'returns_refunds_identity_unavailable') { const sellerId = String(input.shop?.seller_id || ''); if (!/^\d+$/.test(sellerId)) fail(failureCode); return sellerId; }

function validatePage(item, sellerId, expectedTotal = null, rules) {
  const requestSellerId = new URL(item.request_url).searchParams.get(rules.seller_query);
  if (String(requestSellerId) !== sellerId) fail('returns_refunds_identity_mismatch');
  const rawTotal = getPath(item.body, rules.response_fields.total); const total = Number(rawTotal); const rawCards = getPath(item.body, rules.response_fields.records);
  const cards = total === 0 && rawCards == null ? [] : rawCards;
  if (!['number', 'string'].includes(typeof rawTotal) || rawTotal === '' || !Number.isSafeInteger(total) || total < 0)
    fail('returns_refunds_page_invalid', { field_path: rules.response_fields.total.join('.'), failure_kind: 'invalid_total', actual_type: typeof rawTotal });
  if (!Array.isArray(cards) || cards.length > total || ((total === 0) !== (cards.length === 0)))
    fail('returns_refunds_page_invalid', { field_path: rules.response_fields.records.join('.'), failure_kind: 'invalid_records', total });
  if (expectedTotal !== null && total !== expectedTotal)
    fail('returns_refunds_total_drift', { field_path: rules.response_fields.total.join('.'), failure_kind: 'total_drift', expected_total: expectedTotal, actual_total: total });
  return { total, cards };
}

function workbookResult(input, reportSpec, sellerId, capturedAt, cards, status, noDataEvidence = null) {
  const rules = input.providerSpec.api_contract; const currency = status === 'success' ? currencyEvidence(cards, rules) : null;
  fs.mkdirSync(input.outputDir, { recursive: true });
  const outputFile = path.join(input.outputDir, `退货退款诊断快照_${capturedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.xlsx`);
  writeWorkbook(outputFile, rowsFor(reportSpec.headers, cards, capturedAt, rules, currency?.currency_code || ''), { sheetName: rules.card_contract.sheet_name });
  const buffer = fs.readFileSync(outputFile);
  const result = { schema_version: 'returns_refunds_snapshot_v1', status, provider_id: PROVIDER_ID, shop_alias: input.a.shop_alias, shop_id: sellerId, captured_at: capturedAt, date_semantics: 'snapshot', row_count: cards.length, output_file: outputFile, generated_filename: path.basename(outputFile), generated_file: true, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), byte_length: buffer.length };
  if (status === 'no_data') result.no_data_evidence = noDataEvidence;
  else result.currency_evidence = currency;
  return result;
}

async function exportReturnsRefundsSnapshot(input, dependencies = {}) {
  const reportSpec = input?.reportSpec; const rules = validateSpec(reportSpec, input?.providerSpec, { skillRoot: dependencies.skillRoot });
  const sellerId = validatedSellerId(input);
  const browser = dependencies.browser;
  if (!browser || typeof browser.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  const context = dependencies.browserContext;
  if (!context || typeof browser.contexts !== 'function' || !browser.contexts().includes(context)) fail('browser_context_missing');
  const capturedAt = (dependencies.clock || (() => new Date()))().toISOString();
  const page = context.pages().find((item) => item.url() === input.b.seller_page_url)
      || context.pages().find((item) => /^https:\/\/seller/.test(item.url()));
    if (!page) fail('seller_page_missing');
    const origin = sellerOrigin(input.b.seller_page_url);
    const assertSession = () => {
      if (!browser.isConnected()) fail('browser_disconnected');
      if (!browser.contexts().includes(context)) fail('browser_context_missing');
      if (!context.pages().includes(page)) fail('seller_page_missing');
      const current = new URL(page.url());
      if (current.origin !== origin || origin !== rules.response_origin) fail('seller_origin_mismatch');
      if (/(?:login|signin|passport)(?:\/|$)/iu.test(current.pathname)) fail('seller_login_page');
    };
    const target = new URL(rules.endpoint_path, origin);
    for (const [key, value] of Object.entries(rules.request_query)) target.searchParams.set(key, value);
    for (const key of rules.seller_queries) target.searchParams.set(key, sellerId);
    const requestPage = async (offset, expectedTotal = null) => {
      assertSession();
      const diagnostics = { stage: 'returns_pagination', page_number: offset / rules.request_body.count + 1, offset };
      let response;
      try { response = await page.request.post(target.href, { data: { ...structuredClone(rules.request_body), offset }, timeout: rules.page_response_timeout_ms }); }
      catch { assertSession(); fail('returns_refunds_transport_error', diagnostics); }
      assertSession();
      diagnostics.http_status = response.status();
      if ([401, 403].includes(response.status())) fail('transport_login_required', diagnostics);
      const final = new URL(response.url());
      if (final.origin !== origin || final.pathname !== rules.endpoint_path) fail('seller_origin_mismatch', diagnostics);
      for (const key of rules.seller_queries) if (final.searchParams.get(key) !== sellerId) fail('returns_refunds_identity_mismatch', { ...diagnostics, field_path: `query.${key}`, failure_kind: 'seller_binding' });
      const body = await response.json().catch(() => null);
      if (response.status() !== 200 || getPath(body, rules.response_fields.success_code) !== 0) fail('returns_refunds_page_invalid', diagnostics);
      try { return validatePage({ request_url: response.url(), body }, sellerId, expectedTotal, rules); }
      catch (error) { error.diagnostics = { ...diagnostics, ...error.diagnostics }; throw error; }
    };
    const first = await requestPage(0); const total = first.total;
    if (total === 0) return workbookResult(input, reportSpec, sellerId, capturedAt, [], 'no_data', 'official_total_count_zero');
    const cards = []; const unique = new Set();
    for (let offset = 0; offset < total; offset += rules.request_body.count) {
      const current = offset === 0 ? first : await requestPage(offset, total);
      const diagnostics = { stage: 'returns_pagination', offset, total, page_number: offset / rules.request_body.count + 1 };
      if (current.cards.length !== Math.min(rules.request_body.count, total - offset)) fail('returns_refunds_collection_incomplete', { ...diagnostics, failure_kind: 'page_count', card_count: current.cards.length });
      for (const card of current.cards) {
        const id = String(getPath(card, rules.response_fields.record_key) || '').trim();
        if (!id || unique.has(id)) fail('returns_refunds_collection_incomplete', { ...diagnostics, field_path: rules.response_fields.record_key.join('.'), failure_kind: id ? 'duplicate_id' : 'missing_id', unique_count: unique.size });
        unique.add(id); cards.push(card);
      }
    }
    // Re-read the head after a multi-page traversal: changed total/order is not a complete snapshot.
    if (total > rules.request_body.count) {
      const check = await requestPage(0, total);
      const keys = (items) => items.map((item) => getPath(item, rules.response_fields.record_key));
      if (JSON.stringify(keys(check.cards)) !== JSON.stringify(keys(first.cards))) fail('returns_refunds_snapshot_drift', { stage: 'returns_final_check', failure_kind: 'head_changed', total });
    }
  return workbookResult(input, reportSpec, sellerId, capturedAt, cards, 'success');
}

module.exports = { currencyEvidence, exportReturnsRefundsSnapshot, firstText, messages, named, rowsFor, run: exportReturnsRefundsSnapshot, timestamp, validatedSellerId, validatePage, validateSpec };
