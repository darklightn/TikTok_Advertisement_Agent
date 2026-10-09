'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { writeWorkbook } = require('../../common/xlsx_writer');
const { sellerOrigin } = require('../common/inventory_snapshot');

const PROVIDER_ID = 'cross_border';
const REPORT_ID = 'returns_refunds_snapshot';

function fail(code, details) { throw Object.assign(new Error(code), { code, ...(details ? { details } : {}) }); }
function validResponseOrigin(value) { try { return new URL(value).origin === value; } catch { return false; } }
function matchesListResponse(response, rules) { try { const url = new URL(response.url()); return url.origin === rules.response_origin && response.request().method() === rules.method && url.pathname === rules.endpoint_path; } catch { return false; } }
function validateSpec(spec, providerSpec = spec?.providers?.[PROVIDER_ID], options = {}) { try { validateReportSpec(spec, options); } catch { fail('returns_refunds_report_spec_invalid'); } const rules = providerSpec?.api_contract; const empty = rules?.empty_state_patterns; if (spec?.report_id !== REPORT_ID || providerSpec !== spec?.providers?.[PROVIDER_ID] || !rules || !validResponseOrigin(rules.response_origin) || rules.method !== 'POST' || ![rules.entry_path, rules.endpoint_path].every((value) => typeof value === 'string' && value.startsWith('/')) || !rules.entry_query || Object.values(rules.entry_query).some((value) => typeof value !== 'string') || ![rules.seller_query, rules.page_control_template].every((value) => typeof value === 'string' && value) || rules.zero_records_policy !== 'missing_or_empty' || !rules.response_fields || !rules.card_contract || !empty || ![empty.page_title, empty.empty_marker, empty.order_marker].every((value) => typeof value === 'string' && value) || ![empty.summary_zero, empty.pending_zero].every((value) => Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && item)) || ![rules.navigation_timeout_ms, rules.current_page_timeout_ms, rules.list_timeout_ms, rules.poll_interval_ms, rules.page_control_timeout_ms, rules.page_response_timeout_ms].every((value) => Number.isInteger(value) && value > 0)) fail('returns_refunds_report_spec_invalid'); return rules; }
function getPath(value, pathValue) { return (Array.isArray(pathValue) ? pathValue : [pathValue]).reduce((current, key) => current?.[key], value); }
function named(root, name, found = []) { if (!root || typeof root !== 'object') return found; if (root.name === name) found.push(root); for (const value of Object.values(root)) { if (Array.isArray(value)) for (const item of value) named(item, name, found); else if (value && typeof value === 'object') named(value, name, found); } return found; }
function messages(node, rules) { const values = []; const field=rules.card_contract.named_nodes_field; const walk = (value) => { if (!value || typeof value !== 'object') return; if (typeof value.content === 'string') values.push(value.content); if (typeof value[field] === 'string') values.push(value[field].replace(/\{\{[^}]+\}\}/g, '').trim()); for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); } }; walk(node); return [...new Set(values.filter(Boolean))]; }
function timestamp(node, rules) { let result = ''; const field=rules.card_contract.timestamp_field; const walk = (value) => { if (!value || typeof value !== 'object' || result) return; if (value.kvs?.[field]) result = new Date(Number(value.kvs[field]) * 1000).toISOString(); else for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child); } }; walk(node); return result; }
function firstText(card, name, rules) { return messages(named(card, name)[0], rules)[0] || ''; }
function fieldValue(card, name, labels, rules) { return messages(named(card, name)[0], rules).find((value) => !labels.includes(value)) || ''; }
function currencyEvidence(cards, rules) { const currencies = new Set(); const contract=rules.card_contract; for (const item of cards) { const biz=item[contract.biz_data]; const card=item[contract.card]||{}; const amount = String(biz?.[contract.return_price] || firstText(card, contract.refund_amount_nodes[0], rules) || '').trim(); if (!amount) continue; if (amount.startsWith(contract.currency_symbol)) currencies.add('PHP'); else fail('returns_refunds_currency_unknown'); } if (currencies.size !== 1) fail('returns_refunds_currency_unknown'); return { currency_code: [...currencies][0], currency_symbol: contract.currency_symbol, currency_source: 'official_amount_symbol', amount_scope: 'all_monetary_fields' }; }
function rowsFor(headers, cards, capturedAt, rules, currencyCode = '') { if (!Array.isArray(headers) || !headers.length) fail('returns_refunds_report_headers_missing'); const contract=rules.card_contract; const nodes=contract.nodes; const rows = [headers.slice()]; for (const item of cards) { const biz=item[contract.biz_data]||{}; const card = item[contract.card] || {}; const evidence = named(card, nodes.evidence)[0]; rows.push([capturedAt, String(biz[contract.main_order_id] || ''), String(biz[contract.reverse_order_id] || ''), timestamp(named(card, nodes.application_time)[0],rules), firstText(card,nodes.reverse_type,rules), fieldValue(card,nodes.reason,contract.reason_labels,rules), fieldValue(card,nodes.note,contract.note_labels,rules), firstText(card,nodes.product,rules), firstText(card,nodes.paid,rules), biz[contract.return_price] || firstText(card,contract.refund_amount_nodes[0],rules), currencyCode, firstText(card,nodes.status,rules), firstText(card,nodes.logistics_status,rules), timestamp(named(card,nodes.logistics_time)[0],rules), named(card,nodes.tags).flatMap((node)=>messages(node,rules)).filter((value) => !(new RegExp(contract.tag_exclusion_pattern,'u')).test(value)).join('; '), Array.isArray(getPath(evidence,contract.evidence_media_path)) ? getPath(evidence,contract.evidence_media_path).length : 0]); } return rows; }
function validatedSellerId(input, failureCode = 'returns_refunds_identity_unavailable') { const sellerId = String(input.shop?.seller_id || ''); if (!/^\d+$/.test(sellerId)) fail(failureCode); return sellerId; }
function isOfficialEmptyState(bodyText, rules) { const text = String(bodyText || '').replace(/\s+/g, ' ').trim(); const patterns = rules.empty_state_patterns; const zero = (label) => new RegExp(`${label}\\s*0(?:\\s|$)`, 'i').test(text); return new RegExp(patterns.page_title, 'u').test(text) && new RegExp(patterns.empty_marker, 'u').test(text) && patterns.summary_zero.every(zero) && patterns.pending_zero.every(zero) && !new RegExp(patterns.order_marker, 'iu').test(text); }
function successful(items, rules) { return items.filter((item) => getPath(item.body, rules.response_fields.success_code) === 0); }

function validatePage(item, sellerId, expectedTotal = null, rules) {
  const requestSellerId = new URL(item.request_url).searchParams.get(rules.seller_query);
  if (String(requestSellerId) !== sellerId) fail('returns_refunds_identity_mismatch');
  const rawTotal = getPath(item.body, rules.response_fields.total); const total = Number(rawTotal); const rawCards = getPath(item.body, rules.response_fields.records);
  const cards = total === 0 && rawCards == null ? [] : rawCards;
  if (rawTotal === null || rawTotal === undefined || rawTotal === '' || !Number.isInteger(total) || total < 0 || !Array.isArray(cards) || cards.length > total
    || ((total === 0) !== (cards.length === 0))) fail('returns_refunds_page_invalid');
  if (expectedTotal !== null && total !== expectedTotal) fail('returns_refunds_total_drift');
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
    const origin = sellerOrigin(input.b.seller_page_url); const observed = []; const parsing = new Set(); let emptyState = false;
    const listener = (response) => {
      if (!matchesListResponse(response, rules)) return;
      const task = Promise.resolve().then(async () => { try { observed.push({ request_url: response.url(), body: await response.json() }); } catch { /* unparseable responses are not trusted sources */ } });
      parsing.add(task); task.finally(() => parsing.delete(task));
    };
    const settleParsing = async () => { while (parsing.size) await Promise.allSettled([...parsing]); };
    const waitForTerminal = async (timeoutMs) => { const deadline = Date.now() + timeoutMs; do { const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => ''); emptyState = isOfficialEmptyState(bodyText, rules); if (successful(observed, rules).length || emptyState) return; await page.waitForTimeout(rules.poll_interval_ms); } while (Date.now() < deadline); };
    page.on('response', listener);
    try {
      const routeUrl = new URL(rules.entry_path, origin); for (const [key, value] of Object.entries(rules.entry_query)) routeUrl.searchParams.set(key, value);
      if (new URL(page.url()).pathname === rules.entry_path) { await waitForTerminal(rules.current_page_timeout_ms); await settleParsing(); }
      if (!successful(observed, rules).length && !emptyState) {
        await page.goto(routeUrl.href, { waitUntil: 'domcontentloaded', timeout: rules.navigation_timeout_ms });
        await waitForTerminal(rules.list_timeout_ms);
      }
    } finally { page.off('response', listener); }
    await settleParsing();
    const initialResponses = successful(observed, rules);
    if (!initialResponses.length) {
      if (!emptyState) fail('returns_refunds_source_unavailable');
      return workbookResult(input, reportSpec, sellerId, capturedAt, [], 'no_data', 'official_empty_state');
    }
    const first = validatePage(initialResponses[0], sellerId, null, rules); const total = first.total;
    for (const item of initialResponses.slice(1)) validatePage(item, sellerId, total, rules);
    if (total === 0) return workbookResult(input, reportSpec, sellerId, capturedAt, [], 'no_data', 'official_total_count_zero');
    const pages = [first.cards]; const pageCount = Math.ceil(total / first.cards.length);
    for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
      const target = page.locator(rules.page_control_template.replace('{{page_number}}', String(pageNumber))).first();
      try { await target.waitFor({ state: 'attached', timeout: rules.page_control_timeout_ms }); } catch { fail('returns_refunds_page_control_missing'); }
      const responsePromise = page.waitForResponse((response) => matchesListResponse(response, rules), { timeout: rules.page_response_timeout_ms });
      await target.click(); const response = await responsePromise; const body = await response.json().catch(() => null);
      if (getPath(body, rules.response_fields.success_code) !== 0) fail('returns_refunds_page_invalid');
      pages.push(validatePage({ request_url: response.url(), body }, sellerId, total, rules).cards);
    }
    const cards = pages.flat(); const ids = cards.map((item) => String(getPath(item, rules.response_fields.record_key) || '').trim()); const unique = new Set(ids);
    if (cards.length !== total || unique.size !== total || unique.has('')) fail('returns_refunds_collection_incomplete', { total, card_count: cards.length, unique_count: unique.size, page_counts: pages.map((items) => items.length) });
  return workbookResult(input, reportSpec, sellerId, capturedAt, cards, 'success');
}

module.exports = { currencyEvidence, exportReturnsRefundsSnapshot, firstText, isOfficialEmptyState, messages, named, rowsFor, run: exportReturnsRefundsSnapshot, timestamp, validatedSellerId, validatePage, validateSpec };
