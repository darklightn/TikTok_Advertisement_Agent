'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { attachShop, isSellerUrl, parseArgs } = require('../scripts/b_attach_shop');
const { connectExistingBrowser } = require('../scripts/common/playwright_runtime');
const { validateB } = require('../scripts/validation/validate_b');

const input = { shopAlias: 'Exact Shop', browserId: '7', cdpUrl: 'http://127.0.0.1:12345' };
function page(url, text = 'content', title = 'Seller', openButton = null) { return { url: () => url, title: async () => title, evaluate: async () => 'complete', locator: (selector) => selector === 'button.openMallOpenBtn' ? { first: () => openButton || { isEnabled: async () => false } } : { first: () => ({ innerText: async () => text }), innerText: async () => text } }; }
function browser(pages, contexts = true) { return { contexts: () => contexts ? [{ pages: () => pages }] : [], close: async () => {} }; }

test('arguments require A alias, browser ID and loopback CDP', () => {
  assert.deepEqual(parseArgs(['--shop-alias', 'Exact Shop', '--browser-id', '7', '--cdp-url', 'http://127.0.0.1:12345']), input);
  assert.throws(() => parseArgs(['--cdp-url', 'http://example.com:1']), { code: 'invalid_arguments' });
});

test('seller URL rejects extension, blank and login pages', () => {
  assert.equal(isSellerUrl('https://seller-ph.tiktok.com/setup'), true);
  assert.equal(isSellerUrl('https://seller.tiktokshopglobalselling.com/homepage?shop_region=PH'), true);
  assert.equal(isSellerUrl('https://seller-ph.tiktok.com/account/login'), false);
  assert.equal(isSellerUrl('chrome-extension://abc/check.html'), false);
  assert.equal(isSellerUrl('about:blank'), false);
});

test('CDP connection failure is normalized', async () => {
  await assert.rejects(connectExistingBrowser(input.cdpUrl, { playwright: { chromium: { connectOverCDP: async () => { throw new Error('down'); } } }, attempts: 1 }), { code: 'cdp_connect_failed' });
});

test('missing context and Seller page stop read probe', async () => {
  await assert.rejects(attachShop(input, { connect: async () => browser([], false) }), { code: 'browser_context_missing' });
  const anchor = page('chrome-extension://abc/check.html?mallId=7', 'Header\nExact Shop');
  await assert.rejects(attachShop(input, { connect: async () => browser([page('about:blank'), anchor]), sellerTimeoutMs: 0 }), { code: 'seller_page_not_found' });
});

test('waits read-only for a Seller page opened by ZhanFu', async () => {
  const pages = [page('chrome-extension://abc/check.html?mallId=7', 'Header\nExact Shop')];
  const contextBrowser = { contexts: () => [{ pages: () => pages }], close: async () => {} };
  let polls = 0;
  const result = await attachShop(input, {
    connect: async () => contextBrowser,
    sellerTimeoutMs: 1000,
    delay: async () => { polls += 1; pages.push(page('https://seller-ph.tiktok.com/setup', 'Dashboard')); },
  });
  assert.equal(result.seller_page_found, true);
  assert.equal(polls, 1);
});

test('triggers only the identity-bound ZhanFu open-shop button when Seller page is absent', async () => {
  const pages = [];
  let clicks = 0;
  const button = { isEnabled: async () => true, click: async () => { clicks += 1; pages.push(page('https://seller-ph.tiktok.com/setup', 'Dashboard')); } };
  pages.push(page('chrome-extension://abc/check.html?mallId=7', 'Header\nExact Shop', 'ZhanFu', button));
  const result = await attachShop(input, { connect: async () => browser(pages), sellerTimeoutMs: 0 });
  assert.equal(result.shop_open_triggered, true);
  assert.equal(result.mutation_attempted, false);
  assert.equal(clicks, 1);
});

test('missing and mismatched identity anchors are rejected', async () => {
  const seller = page('https://seller-ph.tiktok.com/setup');
  await assert.rejects(attachShop(input, { connect: async () => browser([seller]), identityTimeoutMs: 0 }), { code: 'identity_anchor_missing' });
  const wrong = page('chrome-extension://abc/check.html?mallId=7', 'Different Shop');
  await assert.rejects(attachShop(input, { connect: async () => browser([seller, wrong]), identityTimeoutMs: 0 }), { code: 'identity_mismatch' });
});

test('waits for the identity-bound extension page to appear', async () => {
  const pages = [page('https://seller-ph.tiktok.com/setup', 'Dashboard')];
  let delays = 0;
  const result = await attachShop(input, {
    connect: async () => browser(pages), identityTimeoutMs: 1000, pollMs: 1,
    delay: async () => { delays += 1; pages.push(page('chrome-extension://abc/check.html?mallId=7', 'Exact Shop')); },
  });
  assert.equal(result.identity_match, true);
  assert.equal(delays, 1);
});

test('waits for the exact extension identity text to finish loading', async () => {
  const seller = page('https://seller-ph.tiktok.com/setup', 'Dashboard');
  let reads = 0;
  const anchor = page('chrome-extension://abc/check.html?mallId=7');
  anchor.locator = (selector) => selector === 'body'
    ? { innerText: async () => (++reads > 1 ? 'Header\nExact Shop' : 'Loading') }
    : { first: () => ({ isEnabled: async () => false }) };
  const result = await attachShop(input, { connect: async () => browser([seller, anchor]), delay: async () => {} });
  assert.equal(result.identity_match, true);
  assert.equal(reads, 2);
});

test('valid existing pages produce a contract-valid read-only result', async () => {
  const seller = page('https://seller-ph.tiktok.com/setup', 'Dashboard');
  const anchor = page('chrome-extension://abc/check.html?mallId=7', 'Header\nExact Shop\nOpen');
  const result = await attachShop(input, { connect: async () => browser([seller, anchor]) });
  assert.equal(result.mutation_attempted, false);
  assert.equal(validateB(result, { shop_alias: 'Exact Shop', browser_id: '7', cdp_url: input.cdpUrl }).status, 'passed');
});

test('waits for an existing Seller page body to become ready', async () => {
  let reads = 0;
  const seller = page('https://seller-ph.tiktok.com/setup', 'Dashboard');
  seller.locator = () => ({ first: () => ({ innerText: async () => (++reads === 1 ? '' : 'Dashboard') }) });
  const anchor = page('chrome-extension://abc/check.html?mallId=7', 'Header\nExact Shop');
  let delays = 0;
  const result = await attachShop(input, { connect: async () => browser([seller, anchor]), readinessTimeoutMs: 1000, pollMs: 1, delay: async () => { delays += 1; } });
  assert.equal(result.status, 'operable');
  assert.equal(reads, 2);
  assert.equal(delays, 1);
});

test('validator rejects cross-session results', () => {
  const result = { schema_version: 'b_attach_shop_v1', status: 'operable', seller_page_found: true, identity_match: true, page_read_probe: 'passed', mutation_attempted: false, document_ready_state: 'complete', seller_page_url: 'https://seller-ph.tiktok.com/', identity_anchor: { source: 'zhanfu_extension' }, requested_shop_alias: 'X', browser_id: '8', cdp_url: input.cdpUrl };
  assert.equal(validateB(result, { shop_alias: 'Exact Shop', browser_id: '7', cdp_url: input.cdpUrl }).status, 'failed');
});
