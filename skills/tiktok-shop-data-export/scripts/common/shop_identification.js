'use strict';

const crossBorder = require('../providers/cross_border');
const local = require('../providers/local');

const PROVIDERS = Object.freeze([crossBorder, local]);
const PROVIDER_BY_IDENTITY = Object.freeze({ '1:2': 'cross_border', '2:1': 'local' });
const SELLER_HOSTNAMES = Object.freeze({
  cross_border: 'seller.tiktokshopglobalselling.com',
  local: 'seller-ph.tiktok.com',
});

function codedError(code) { return Object.assign(new Error(code), { code }); }

function sellerHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function identifyShop(aResult, bResult, identity, providers = PROVIDERS) {
  if (aResult?.status !== 'ready' || bResult?.status !== 'operable') throw codedError('invalid_input');
  if (aResult.shop_alias !== bResult.requested_shop_alias
    || String(aResult.browser_id) !== String(bResult.browser_id)
    || aResult.cdp_url !== bResult.cdp_url) throw codedError('identity_mismatch');

  const providerId = PROVIDER_BY_IDENTITY[`${identity?.seller_type}:${identity?.business_type}`];
  if (!providerId) throw codedError('unsupported_shop_type');
  const selected = providers.find((provider) => provider.provider_id === providerId);
  if (!selected) throw codedError('unsupported_shop_type');
  const platformName = String(aResult.shop_platform_name || '');
  const hostname = sellerHostname(bResult.seller_page_url);
  if (!selected.supports(platformName) || hostname !== SELLER_HOSTNAMES[providerId]) {
    throw codedError('provider_identity_mismatch');
  }
  return {
    schema_version: 'shop_identification_v1', status: 'identified', shop_alias: aResult.shop_alias,
    browser_id: String(aResult.browser_id), cdp_url: aResult.cdp_url, shop_type: selected.shop_type,
    provider_id: selected.provider_id, platform_name: platformName, seller_hostname: hostname,
    seller_id: identity.seller_id, shop_code: identity.shop_code,
    seller_type: identity.seller_type, business_type: identity.business_type,
    shop_region: identity.shop_region, region_code: identity.region_code,
    evidence: { official_identity_classification: 'passed', platform_consistency: 'passed', session_binding: 'passed' },
    observed_at: new Date().toISOString(),
  };
}

module.exports = { PROVIDERS, PROVIDER_BY_IDENTITY, SELLER_HOSTNAMES, identifyShop, sellerHostname };
