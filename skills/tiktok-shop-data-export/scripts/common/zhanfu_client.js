'use strict';

const DEFAULT_ZHANFU_BASE = 'http://127.0.0.1:45008';

function codedError(code, message, detail = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function normalizedShopAlias(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function shopAliasReferences(value) {
  const normalized = normalizedShopAlias(value); const references = [normalized];
  for (const suffix of ['店铺', '店']) if (normalized.endsWith(suffix) && normalized.length > suffix.length) references.push(normalized.slice(0, -suffix.length));
  return [...new Set(references)];
}

async function fetchJson(url, options, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw codedError('zhanfu_http_error', `HTTP ${response.status}`, { response_text: text.slice(0, 500) });
    try { return JSON.parse(text); } catch { throw codedError('zhanfu_invalid_json', 'ZhanFu returned invalid JSON'); }
  } catch (error) {
    if (error.code) throw error;
    throw codedError(error.name === 'AbortError' ? 'zhanfu_http_timeout' : 'zhanfu_http_unavailable', String(error.message || error));
  } finally {
    clearTimeout(timer);
  }
}

function createZhanFuClient(baseUrl = DEFAULT_ZHANFU_BASE, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = baseUrl.replace(/\/$/, '');

  async function callWebDriver(action, args = '', browserId, timeoutMs = 60000) {
    const payload = { action, module: 'WebDriverModule', args };
    if (browserId !== undefined) payload.browserId = String(browserId);
    return fetchJson(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, timeoutMs, fetchImpl);
  }

  async function listShops(limit = 500) {
    const result = await callWebDriver('GetBrowserList', JSON.stringify({ page: 1, limit }));
    return result?.returnObj?.data?.mall_list || [];
  }

  async function resolveShop(shopAlias) {
    const shops = await listShops(); const raw = String(shopAlias || '').trim();
    const exact = shops.filter((shop) => String(shop.mall_name || '') === raw);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw codedError('shop_alias_ambiguous', 'Exact shop alias matched multiple profiles', { match_count: exact.length });
    const references = shopAliasReferences(raw);
    const matches = shops.filter((shop) => references.includes(normalizedShopAlias(shop.mall_name)));
    if (matches.length === 0) throw codedError('shop_not_found', 'Shop alias was not found', { match_count: 0 });
    if (matches.length > 1) throw codedError('shop_alias_ambiguous', 'Shop alias matched multiple profiles', { match_count: matches.length });
    return matches[0];
  }

  async function getLiveCdp(browserId) {
    const result = await callWebDriver('GetBrowserWebDriver', '', browserId, 45000);
    const port = Number(result?.returnObj?.WebDriverPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const cdpUrl = `http://127.0.0.1:${port}`;
    const version = await fetchJson(`${cdpUrl}/json/version`, { method: 'GET' }, 5000, fetchImpl);
    if (!version.webSocketDebuggerUrl) throw codedError('cdp_unavailable', 'CDP version has no WebSocket debugger URL');
    return { cdpUrl, version };
  }

  async function openBrowser(browserId) {
    return callWebDriver('OpenBrowser', JSON.stringify({ isDownLoadConfirm: false, isOpenMallIndex: true }), browserId, 120000);
  }

  async function closeBrowser(browserId) {
    const result = await callWebDriver('CloseBrowser', '', browserId, 120000);
    if (String(result?.ret) !== '200') throw codedError('cdp_recovery_close_failed', 'ZhanFu did not confirm browser closure');
    return result;
  }

  async function restartBrowser(browserId, options = {}) {
    const previousWebSocket = String(options.previousWebSocketDebuggerUrl || '');
    await closeBrowser(browserId);
    await delay(Number(options.closeSettleMs ?? 3000));
    await openBrowser(browserId);
    const deadline = Date.now() + Number(options.timeoutMs || 60000);
    do {
      const live = await getLiveCdp(browserId).catch(() => null);
      if (live && (!previousWebSocket || live.version.webSocketDebuggerUrl !== previousWebSocket)) return { ...live, sessionMode: 'opened' };
      await delay(Number(options.pollMs || 1000));
    } while (Date.now() < deadline);
    throw codedError('cdp_recovery_failed', 'Browser did not expose a fresh CDP endpoint');
  }

  async function ensureLiveCdp(browserId, options = {}) {
    const existing = await getLiveCdp(browserId).catch(() => null);
    if (existing) return { ...existing, sessionMode: 'reused' };
    await openBrowser(browserId);
    const deadline = Date.now() + Number(options.timeoutMs || 60000);
    do {
      const live = await getLiveCdp(browserId).catch(() => null);
      if (live) return { ...live, sessionMode: 'opened' };
      await delay(Number(options.pollMs || 1000));
    } while (Date.now() < deadline);
    throw codedError('cdp_unavailable', 'Browser did not expose a live CDP endpoint');
  }

  return { baseUrl: base, callWebDriver, closeBrowser, ensureLiveCdp, getLiveCdp, listShops, openBrowser, resolveShop, restartBrowser };
}

module.exports = { DEFAULT_ZHANFU_BASE, codedError, createZhanFuClient, normalizedShopAlias, shopAliasReferences };
