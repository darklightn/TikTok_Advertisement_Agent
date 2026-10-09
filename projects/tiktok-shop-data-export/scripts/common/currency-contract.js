'use strict';

const SYMBOL_TO_CODE = Object.freeze({ '₱': 'PHP' });

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function field(value) { return typeof value === 'string' && /^[a-z0-9_]+$/u.test(value); }
function validPath(value) { return Array.isArray(value) && value.length && value.every(field); }
function pathValue(value, parts) { return parts.reduce((current, part) => current?.[part], value); }

function normalizeCurrencyCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(code)) fail('currency_code_invalid');
  return code;
}

function validateCurrencyContract(contract) {
  let normalizedCode = null;
  try { normalizedCode = normalizeCurrencyCode(contract?.currency_code); } catch {}
  if (!object(contract)
    || contract.schema_version !== 'currency_contract_v1'
    || !['official_report_page_symbol', 'product_list_api_currency_code'].includes(contract.source_kind)
    || contract.output_kind !== 'embedded_table_metadata'
    || contract.amount_scope !== 'all_monetary_fields'
    || typeof contract.currency_symbol !== 'string'
    || !contract.currency_symbol
    || normalizedCode !== contract.currency_code
    || SYMBOL_TO_CODE[contract.currency_symbol] !== contract.currency_code
    || (contract.source_kind === 'product_list_api_currency_code'
      && (!validPath(contract.api_items_path) || !validPath(contract.api_metric_container_path)
        || !field(contract.api_currency_field) || !Array.isArray(contract.api_amount_sibling_fields)
        || !contract.api_amount_sibling_fields.length || contract.api_amount_sibling_fields.some((name) => !field(name))
        || (contract.fallback_source_kind !== undefined
          && contract.fallback_source_kind !== 'official_report_page_symbol')))) {
    fail('currency_contract_invalid');
  }
  return contract;
}

function currencyEvidenceFromApi(body, contract) {
  const validated = validateCurrencyContract(contract);
  if (validated.source_kind !== 'product_list_api_currency_code') fail('currency_contract_invalid');
  const items = pathValue(body, validated.api_items_path);
  if (!Array.isArray(items)) fail('currency_evidence_missing');
  const observed = [];
  for (const item of items) {
    const metrics = pathValue(item, validated.api_metric_container_path);
    if (!object(metrics)) continue;
    for (const metric of Object.values(metrics)) {
      if (!object(metric) || !validated.api_amount_sibling_fields.some((name) => Object.hasOwn(metric, name))) continue;
      if (metric[validated.api_currency_field] == null || String(metric[validated.api_currency_field]).trim() === '') continue;
      observed.push(normalizeCurrencyCode(metric[validated.api_currency_field]));
    }
  }
  if (!observed.length) fail('currency_evidence_missing');
  if (new Set(observed).size !== 1 || observed[0] !== validated.currency_code) fail('currency_evidence_conflict');
  return {
    currency_code: observed[0], currency_symbol: validated.currency_symbol,
    currency_source: validated.source_kind, amount_scope: validated.amount_scope,
  };
}

function currencyEvidenceFromText(value, contract) {
  const validated = validateCurrencyContract(contract);
  const source = validated.source_kind === 'product_list_api_currency_code'
    ? validated.fallback_source_kind : validated.source_kind;
  if (source !== 'official_report_page_symbol') fail('currency_evidence_missing');
  const observed = String(value || '');
  if (!observed.includes(validated.currency_symbol)) fail('currency_evidence_missing');
  return {
    currency_code: validated.currency_code,
    currency_symbol: validated.currency_symbol,
    currency_source: source,
    amount_scope: validated.amount_scope,
  };
}

async function captureOfficialPageCurrency(target, contract, dependencies = {}) {
  const validated = validateCurrencyContract(contract);
  const pageSymbolAllowed = validated.source_kind === 'official_report_page_symbol'
    || validated.fallback_source_kind === 'official_report_page_symbol';
  if (!pageSymbolAllowed) fail('currency_evidence_missing');
  const readers = [];
  if (Object.hasOwn(dependencies, 'currencyText')) readers.push(async () => dependencies.currencyText);
  else if (typeof dependencies.readCurrencyText === 'function') readers.push(async () => dependencies.readCurrencyText(target));
  else {
    if (typeof target?.evaluate === 'function') {
      readers.push(async () => target.evaluate(() => globalThis.document?.body?.innerText || ''));
    }
    if (typeof target?.url === 'function' && typeof target?.locator === 'function') {
      readers.push(async () => target.locator('body').innerText());
    }
    if (typeof target?.innerText === 'function') readers.push(async () => target.innerText());
    if (typeof target?.url !== 'function' && typeof target?.locator === 'function') {
      readers.push(async () => target.locator('body').innerText());
    }
  }
  for (const read of readers) {
    try {
      return currencyEvidenceFromText(await read(), contract);
    } catch (error) {
      if (error?.code && error.code !== 'currency_evidence_missing') throw error;
    }
  }
  fail('currency_evidence_missing');
}

async function waitOfficialPageCurrency(target, contract, timeout, dependencies = {}) {
  const deadline = Date.now() + timeout;
  const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  do {
    try {
      return await captureOfficialPageCurrency(target, contract, dependencies);
    } catch (error) {
      if (error?.code !== 'currency_evidence_missing') throw error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (true);
  fail('currency_evidence_missing');
}

async function captureProductListCurrency(body, target, contract, dependencies = {}) {
  try { return currencyEvidenceFromApi(body, contract); }
  catch (error) {
    if (error?.code !== 'currency_evidence_missing') throw error;
    if (contract?.fallback_source_kind !== 'official_report_page_symbol') throw error;
    return captureOfficialPageCurrency(target, contract, dependencies);
  }
}

function validateCurrencyEvidence(evidence, contract) {
  const validated = validateCurrencyContract(contract);
  if (!object(evidence)
    || evidence.currency_code !== validated.currency_code
    || evidence.currency_symbol !== validated.currency_symbol
    || ![validated.source_kind, ...(validated.fallback_source_kind ? [validated.fallback_source_kind] : [])]
      .includes(evidence.currency_source)
    || evidence.amount_scope !== validated.amount_scope) fail('currency_evidence_invalid');
  return evidence;
}

module.exports = {
  SYMBOL_TO_CODE,
  captureOfficialPageCurrency,
  waitOfficialPageCurrency,
  captureProductListCurrency,
  currencyEvidenceFromApi,
  currencyEvidenceFromText,
  normalizeCurrencyCode,
  validateCurrencyContract,
  validateCurrencyEvidence,
};
