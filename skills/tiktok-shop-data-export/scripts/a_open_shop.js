#!/usr/bin/env node
'use strict';

const { writeJsonLine } = require('./common/result');
const { DEFAULT_ZHANFU_BASE, createZhanFuClient } = require('./common/zhanfu_client');
const { defaultIpcPort, ensureZhanFuService, resolveIpcPort, runtimeMode } = require('./common/zhanfu_runtime');

function parseArgs(argv) {
  const index = argv.indexOf('--shop-alias');
  const shopAlias = index >= 0 ? argv[index + 1] : '';
  if (!shopAlias || shopAlias.startsWith('--')) throw Object.assign(new Error('Provide --shop-alias'), { code: 'invalid_arguments' });
  return { shopAlias };
}

async function openExactShop(shopAlias, dependencies = {}) {
  const env = dependencies.env || process.env; const mode = dependencies.runtimeMode || runtimeMode(env); const ipcPort = dependencies.client ? Number(dependencies.ipcPort || env.ZHANFU_IPC_PORT || defaultIpcPort(mode)) : await (dependencies.resolveIpcPort || resolveIpcPort)(mode, { ipcPort: dependencies.ipcPort, env, inspectSessions: dependencies.inspectSessions });
  const client = dependencies.client || createZhanFuClient(process.env.ZHANFU_BASE_URL || (ipcPort === 45008 ? DEFAULT_ZHANFU_BASE : `http://127.0.0.1:${ipcPort}`));
  const service = await (dependencies.ensureService || ensureZhanFuService)(client, { ipcPort, runtimeMode: mode });
  const shop = await client.resolveShop(shopAlias);
  const browserId = shop.mall_id ?? shop.browser_id ?? shop.browserId ?? shop.id;
  if (browserId === undefined || browserId === null || browserId === '') throw Object.assign(new Error('Shop profile has no browser ID'), { code: 'browser_open_failed' });
  const live = await client.ensureLiveCdp(browserId);
  return {
    schema_version: 'a_open_shop_v1', status: 'ready', requested_shop_alias: shopAlias, shop_alias: String(shop.mall_name || shopAlias),
    browser_id: String(browserId), cdp_url: live.cdpUrl, zhanfu_base_url: client.baseUrl, session_mode: live.sessionMode,
    shop_platform_name: String(shop.platform_name || ''), runtime_mode: mode,
    ...(service.active_session_id ? { active_session_id: service.active_session_id, service_session_id: service.service_session_id } : {}),
    web_socket_debugger_url: live.version.webSocketDebuggerUrl, observed_at: new Date().toISOString(),
  };
}

function blockedResult(error) {
  const known = new Set(['invalid_arguments', 'shop_not_found', 'shop_alias_ambiguous', 'zhanfu_client_not_found', 'zhanfu_service_unavailable', 'zhanfu_interactive_session_unavailable', 'zhanfu_interactive_launch_failed', 'zhanfu_session_mismatch', 'zhanfu_mode_conflict', 'zhanfu_runtime_mode_invalid', 'browser_open_failed', 'cdp_unavailable']);
  return { schema_version: 'a_open_shop_v1', status: 'blocked', reason_code: known.has(error.code) ? error.code : 'zhanfu_service_unavailable' };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const { shopAlias } = parseArgs(argv);
    writeJsonLine(await openExactShop(shopAlias, dependencies));
    return 0;
  } catch (error) {
    writeJsonLine(blockedResult(error));
    return 2;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { blockedResult, main, openExactShop, parseArgs };
