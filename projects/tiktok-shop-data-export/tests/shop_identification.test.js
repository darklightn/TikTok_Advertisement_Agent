'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { identifyShop } = require('../scripts/common/shop_identification');
const { validateIdentification } = require('../scripts/validation/validate_shop_identification');

function inputs(platformName, sellerUrl = 'https://seller.tiktokshopglobalselling.com/homepage') {
  const a = { status: 'ready', shop_alias: 'Dynamic Shop', browser_id: '7', cdp_url: 'http://127.0.0.1:12345', shop_platform_name: platformName };
  const b = { status: 'operable', requested_shop_alias: 'Dynamic Shop', browser_id: '7', cdp_url: 'http://127.0.0.1:12345', seller_page_url: sellerUrl };
  return { a, b };
}

function identity(overrides = {}) {
  return {
    seller_id: '88001', shop_code: 'SHOP001', seller_type: 1, business_type: 2,
    shop_region: 'PH', region_code: 'CN', ...overrides,
  };
}

test('selects cross-border provider from authoritative identity and verifies platform plus hostname', () => {
  const { a, b } = inputs('TikTok Shop后台 跨境(新)-全球');
  const result = identifyShop(a, b, identity());
  assert.equal(result.provider_id, 'cross_border');
  assert.equal(result.seller_type, 1); assert.equal(result.business_type, 2);
  assert.equal(validateIdentification(result, a, b).status, 'passed');
});

test('selects local provider from authoritative identity', () => {
  const { a, b } = inputs('TikTok Shop后台 本土-菲律宾', 'https://seller-ph.tiktok.com/setup');
  const result = identifyShop(a, b, identity({ seller_type: 2, business_type: 1, region_code: 'PH' }));
  assert.equal(result.provider_id, 'local');
  assert.equal(validateIdentification(result, a, b).status, 'passed');
});

test('validator rejects forged provider mapping and seller hostname', () => {
  const { a, b } = inputs('TikTok Shop后台 本土-菲律宾', 'https://seller-ph.tiktok.com/home');
  const valid = identifyShop(a, b, identity({ seller_type: 2, business_type: 1, region_code: 'PH' }));
  const forged = { ...valid, seller_type: 1, business_type: 2, seller_hostname: 'evil.example' };
  const validation = validateIdentification(forged, a, b);
  assert.equal(validation.status, 'failed');
  for (const code of ['official_identity_mapping', 'seller_hostname', 'seller_page_hostname']) {
    assert.equal(validation.errors.includes(code), true, code);
  }
});

test('validator fails closed on unknown tuples hostname drift and unsupported platform', () => {
  const cross = inputs('TikTok Shop后台 跨境(新)-全球');
  const valid = identifyShop(cross.a, cross.b, identity());

  const unknown = validateIdentification({ ...valid, seller_type: 9, business_type: 9 }, cross.a, cross.b);
  assert.equal(unknown.status, 'failed'); assert.equal(unknown.errors.includes('official_identity_mapping'), true);

  const wrongResultHost = validateIdentification({ ...valid, seller_hostname: 'evil.example' }, cross.a, cross.b);
  assert.equal(wrongResultHost.status, 'failed'); assert.equal(wrongResultHost.errors.includes('seller_hostname'), true);

  const wrongPage = { ...cross.b, seller_page_url: 'https://evil.example/home' };
  const wrongPageHost = validateIdentification(valid, cross.a, wrongPage);
  assert.equal(wrongPageHost.status, 'failed'); assert.equal(wrongPageHost.errors.includes('seller_page_hostname'), true);

  const localPlatform = { ...cross.a, shop_platform_name: 'TikTok Shop后台 本土-菲律宾' };
  const unsupportedPlatform = validateIdentification({ ...valid, platform_name:localPlatform.shop_platform_name }, localPlatform, cross.b);
  assert.equal(unsupportedPlatform.status, 'failed'); assert.equal(unsupportedPlatform.errors.includes('provider_support'), true);
});

test('unknown official type combinations stop without fallback', () => {
  const { a, b } = inputs('TikTok Shop后台 本土-菲律宾', 'https://seller-ph.tiktok.com/setup');
  for (const official of [identity({ seller_type: 1, business_type: 1 }), identity({ seller_type: 3, business_type: 2 }), {}]) {
    assert.throws(() => identifyShop(a, b, official), { code: 'unsupported_shop_type' });
  }
});

test('platform or exact seller hostname conflicts with official type', () => {
  for (const [platform, sellerUrl] of [
    ['TikTok Shop后台 本土-菲律宾', 'https://seller.tiktokshopglobalselling.com/home'],
    ['TikTok Shop后台 跨境(新)-全球', 'https://seller-ph.tiktok.com/home'],
    ['TikTok Shop后台 跨境(新)-全球', 'https://seller.tiktokglobalshop.com/home'],
  ]) {
    const { a, b } = inputs(platform, sellerUrl);
    assert.throws(() => identifyShop(a, b, identity()), { code: 'provider_identity_mismatch' });
  }
});

test('cross-session input stops identity classification', () => {
  const { a, b } = inputs('TikTok Shop后台 本土-菲律宾'); b.browser_id = '8';
  assert.throws(() => identifyShop(a, b, identity()), { code: 'identity_mismatch' });
});

test('shop names do not influence provider selection', () => {
  const { a, b } = inputs('TikTok Shop后台 本土-菲律宾', 'https://seller-ph.tiktok.com/home'); a.shop_alias = '跨境测试名'; b.requested_shop_alias = '跨境测试名';
  assert.equal(identifyShop(a, b, identity({ seller_type: 2, business_type: 1, region_code: 'PH' })).provider_id, 'local');
});
