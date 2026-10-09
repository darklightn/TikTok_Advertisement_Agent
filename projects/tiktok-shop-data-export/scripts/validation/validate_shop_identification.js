#!/usr/bin/env node
'use strict';

const { readJsonFile } = require('./validate_b');
const { writeJsonLine } = require('../common/result');
const { PROVIDERS, PROVIDER_BY_IDENTITY, SELLER_HOSTNAMES, sellerHostname } = require('../common/shop_identification');

function option(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; }
function validateIdentification(result, a, b) {
  const errors = [];
  if (result?.schema_version !== 'shop_identification_v1') errors.push('schema_version');
  if (result?.status !== 'identified') errors.push('status');
  if (!PROVIDERS.some((provider) => provider.shop_type === result?.shop_type)) errors.push('shop_type');
  if (result?.provider_id !== result?.shop_type) errors.push('provider_id');
  if (!/^\d+$/.test(String(result?.seller_id || ''))) errors.push('seller_id');
  if (typeof result?.shop_code !== 'string' || !result.shop_code) errors.push('shop_code');
  if (!Number.isInteger(result?.seller_type) || !Number.isInteger(result?.business_type)) errors.push('seller_type');
  if (typeof result?.shop_region !== 'string' || !result.shop_region
    || typeof result?.region_code !== 'string' || !result.region_code) errors.push('region');
  if (result?.shop_alias !== a?.shop_alias || result?.shop_alias !== b?.requested_shop_alias) errors.push('shop_alias');
  if (String(result?.browser_id) !== String(a?.browser_id) || String(result?.browser_id) !== String(b?.browser_id)) errors.push('browser_id');
  if (result?.cdp_url !== a?.cdp_url || result?.cdp_url !== b?.cdp_url) errors.push('cdp_url');
  if (result?.platform_name !== a?.shop_platform_name) errors.push('platform_name');
  const mappedProviderId = PROVIDER_BY_IDENTITY[`${result?.seller_type}:${result?.business_type}`];
  if (!mappedProviderId || result?.provider_id !== mappedProviderId || result?.shop_type !== mappedProviderId) {
    errors.push('official_identity_mapping');
  }
  const provider = PROVIDERS.find((candidate) => candidate.provider_id === mappedProviderId);
  if (!provider || !provider.supports(result?.platform_name)) errors.push('provider_support');
  if (!mappedProviderId || result?.seller_hostname !== SELLER_HOSTNAMES[mappedProviderId]) errors.push('seller_hostname');
  if (sellerHostname(b?.seller_page_url) !== result?.seller_hostname) errors.push('seller_page_hostname');
  if (result?.evidence?.official_identity_classification !== 'passed'
    || result?.evidence?.platform_consistency !== 'passed'
    || result?.evidence?.session_binding !== 'passed') errors.push('evidence');
  return { schema_version: 'validation_result_v1', component: 'shop_identification', status: errors.length ? 'failed' : 'passed', errors };
}
function main(argv = process.argv.slice(2)) {
  try {
    const a = readJsonFile(option(argv, '--a-result')); const b = readJsonFile(option(argv, '--b-result')); const result = readJsonFile(option(argv, '--result'));
    const validation = validateIdentification(result, a, b); writeJsonLine(validation); return validation.status === 'passed' ? 0 : 2;
  } catch { writeJsonLine({ schema_version: 'validation_result_v1', component: 'shop_identification', status: 'failed', errors: ['invalid_input'] }); return 2; }
}

if (require.main === module) process.exitCode = main();
module.exports = { validateIdentification };
