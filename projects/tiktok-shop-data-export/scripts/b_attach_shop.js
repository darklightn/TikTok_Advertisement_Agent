#!/usr/bin/env node
'use strict';

const { writeJsonLine } = require('./common/result');
const { connectExistingBrowser } = require('./common/playwright_runtime');

function codedError(code, message) { return Object.assign(new Error(message || code), { code }); }

function parseArgs(argv) {
  const read = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : ''; };
  const shopAlias = read('--shop-alias');
  const browserId = read('--browser-id');
  const cdpUrl = read('--cdp-url');
  if (!shopAlias || !browserId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(cdpUrl)) throw codedError('invalid_arguments');
  return { shopAlias, browserId: String(browserId), cdpUrl };
}

function isSellerUrl(url) {
  try {
    const parsed = new URL(url);
    const sellerHost = /^seller(?:-[a-z]{2})?\.tiktok\.com$/i.test(parsed.hostname)
      || ['seller.tiktokglobalshop.com', 'seller.tiktokshopglobalselling.com'].includes(parsed.hostname);
    const loginPath = /\/(?:account\/)?(?:login|signin)(?:\/|$)/i.test(parsed.pathname);
    return parsed.protocol === 'https:' && sellerHost && !loginPath;
  } catch { return false; }
}

function extensionMallId(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'chrome-extension:' ? parsed.searchParams.get('mallId') : null; }
  catch { return null; }
}

async function attachShop(input, dependencies = {}) {
  const browser = await (dependencies.connect || connectExistingBrowser)(input.cdpUrl);
  try {
    const contexts = browser.contexts();
    if (!contexts.length) throw codedError('browser_context_missing');
    const context = contexts[0];
    const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const identityDeadline = Date.now() + Number(dependencies.identityTimeoutMs ?? 15000);
    const initialPages = context.pages();
    let anchorPage;
    do {
      anchorPage = context.pages().find((page) => extensionMallId(page.url()) === input.browserId);
      if (anchorPage) break;
      if (Date.now() >= identityDeadline) throw codedError('identity_anchor_missing');
      await delay(Number(dependencies.pollMs ?? 1000));
    } while (true);

    let anchorText = '';
    do {
      try { anchorText = await anchorPage.locator('body').innerText({ timeout: 5000 }); }
      catch { throw codedError('identity_anchor_missing'); }
      if (anchorText.split(/\r?\n/).map((line) => line.trim()).includes(input.shopAlias)) break;
      if (Date.now() >= identityDeadline) throw codedError('identity_mismatch');
      await delay(Number(dependencies.pollMs ?? 1000));
    } while (true);

    let shopOpenTriggered = false;
    if (!initialPages.some((page) => isSellerUrl(page.url()))) {
      const openButton = anchorPage.locator('button.openMallOpenBtn').first();
      const enabled = await openButton.isEnabled({ timeout: 3000 }).catch(() => false);
      if (enabled) {
        await openButton.click();
        shopOpenTriggered = true;
      }
    }
    const deadline = Date.now() + Number(dependencies.sellerTimeoutMs ?? 60000);
    let sellerPage;
    do {
      sellerPage = context.pages().find((page) => isSellerUrl(page.url()));
      if (sellerPage) break;
      if (Date.now() >= deadline) break;
      await delay(Number(dependencies.pollMs ?? 1000));
    } while (true);
    if (!sellerPage) throw codedError('seller_page_not_found');

    let title; let readyState; let bodyText; let readError;
    const readinessDeadline = Date.now() + Number(dependencies.readinessTimeoutMs ?? 15000);
    do {
      try {
        [title, readyState, bodyText] = await Promise.all([
          sellerPage.title(), sellerPage.evaluate(() => document.readyState), sellerPage.locator('body').first().innerText({ timeout: 5000 }),
        ]);
        readError = null;
        if (['interactive', 'complete'].includes(readyState) && bodyText.trim()) break;
      } catch (error) { readError = error; }
      if (Date.now() >= readinessDeadline) break;
      await delay(Number(dependencies.pollMs ?? 1000));
    } while (true);
    if (readError) throw codedError('page_read_failed');
    if (!['interactive', 'complete'].includes(readyState) || !bodyText.trim()) throw codedError('seller_page_invalid');

    return {
      schema_version: 'b_attach_shop_v1', status: 'operable', requested_shop_alias: input.shopAlias,
      browser_id: input.browserId, cdp_url: input.cdpUrl, seller_page_found: true, seller_page_url: sellerPage.url(),
      seller_page_title: title, document_ready_state: readyState, identity_match: true,
      identity_anchor: { source: 'zhanfu_extension', shop_alias: input.shopAlias, browser_id: input.browserId },
      shop_open_triggered: shopOpenTriggered, page_read_probe: 'passed', mutation_attempted: false, observed_at: new Date().toISOString(),
    };
  } finally {
    if (typeof browser.close === 'function') await browser.close().catch(() => {});
  }
}

function blockedResult(error) {
  const codes = new Set(['invalid_arguments', 'cdp_connect_failed', 'browser_context_missing', 'seller_page_not_found', 'seller_page_invalid', 'identity_anchor_missing', 'identity_mismatch', 'page_read_failed']);
  return { schema_version: 'b_attach_shop_v1', status: 'blocked', reason_code: codes.has(error.code) ? error.code : 'page_read_failed' };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  try { const result = await attachShop(parseArgs(argv), dependencies); writeJsonLine(result); return 0; }
  catch (error) { writeJsonLine(blockedResult(error)); return 2; }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { attachShop, blockedResult, extensionMallId, isSellerUrl, main, parseArgs };
