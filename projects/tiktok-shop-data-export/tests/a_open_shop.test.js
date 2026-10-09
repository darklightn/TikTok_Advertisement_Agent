'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createZhanFuClient } = require('../scripts/common/zhanfu_client');
const { openExactShop, parseArgs } = require('../scripts/a_open_shop');
const { validateA } = require('../scripts/validation/validate_a');
const { defaultIpcPort, ensureZhanFuService, resolveIpcPort, runtimeMode } = require('../scripts/common/zhanfu_runtime');

function response(value) { return { ok: true, text: async () => JSON.stringify(value) }; }

test('parseArgs requires an exact alias', () => {
  assert.deepEqual(parseArgs(['--shop-alias', 'Exact Shop']), { shopAlias: 'Exact Shop' });
  assert.throws(() => parseArgs([]), { code: 'invalid_arguments' });
});

test('resolveShop rejects zero and duplicate exact matches', async () => {
  for (const list of [[], [{ mall_name: 'X' }, { mall_name: 'X' }]]) {
    const client = createZhanFuClient(undefined, { fetchImpl: async () => response({ returnObj: { data: { mall_list: list } } }) });
    await assert.rejects(client.resolveShop('X'), { code: list.length ? 'shop_alias_ambiguous' : 'shop_not_found' });
  }
});

test('resolveShop returns the sole exact match', async () => {
  const list = [{ mall_name: 'Similar' }, { mall_name: 'Exact', mall_id: 7 }];
  const client = createZhanFuClient(undefined, { fetchImpl: async () => response({ returnObj: { data: { mall_list: list } } }) });
  assert.equal((await client.resolveShop('Exact')).mall_id, 7);
});

test('resolveShop safely normalizes spoken suffixes full-width text and spaces', async () => {
  const list = [{ mall_name: '美妆001', mall_id: 7 }, { mall_name: '美妆001备用', mall_id: 8 }];
  const client = createZhanFuClient(undefined, { fetchImpl: async () => response({ returnObj: { data: { mall_list: list } } }) });
  assert.equal((await client.resolveShop(' 美妆 ００１ 店铺 ')).mall_id, 7);
});

test('ensureLiveCdp reuses a live dynamic port without opening', async () => {
  const actions = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/json/version')) return response({ webSocketDebuggerUrl: 'ws://127.0.0.1:32123/devtools/browser/x' });
    const body = JSON.parse(options.body); actions.push(body.action);
    return response({ returnObj: { WebDriverPort: 32123 } });
  };
  const live = await createZhanFuClient(undefined, { fetchImpl }).ensureLiveCdp('7');
  assert.equal(live.cdpUrl, 'http://127.0.0.1:32123');
  assert.equal(live.sessionMode, 'reused');
  assert.deepEqual(actions, ['GetBrowserWebDriver']);
});

test('ensureLiveCdp opens and then returns the newly observed port', async () => {
  let queries = 0;
  const actions = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/json/version')) return response({ webSocketDebuggerUrl: 'ws://127.0.0.1:41234/devtools/browser/y' });
    const body = JSON.parse(options.body); actions.push(body.action);
    if (body.action === 'GetBrowserWebDriver') return response({ returnObj: { WebDriverPort: ++queries > 1 ? 41234 : 0 } });
    return response({ ret: 200 });
  };
  const live = await createZhanFuClient(undefined, { fetchImpl, delay: async () => {} }).ensureLiveCdp('8', { pollMs: 0 });
  assert.equal(live.sessionMode, 'opened');
  assert.deepEqual(actions, ['GetBrowserWebDriver', 'OpenBrowser', 'GetBrowserWebDriver']);
});

test('openExactShop returns a contract-valid result', async () => {
  const client = { baseUrl: 'http://127.0.0.1:45009', resolveShop: async () => ({ mall_name: '美妆001', browser_id: 9, platform_name: 'TikTok Shop后台 本土-菲律宾' }), ensureLiveCdp: async () => ({ cdpUrl: 'http://127.0.0.1:45678', sessionMode: 'opened', version: { webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/browser/z' } }) };
  const result = await openExactShop('美妆001店', { client, ensureService: async () => ({ serviceMode: 'reused' }) });
  assert.equal(result.requested_shop_alias, '美妆001店');
  assert.equal(result.shop_alias, '美妆001');
  assert.equal(result.runtime_mode, 'interactive_shared');
  assert.equal(result.zhanfu_base_url, 'http://127.0.0.1:45009');
  assert.equal(validateA(result).status, 'passed');
});

test('interactive shared is default while background mode keeps the legacy port', () => {
  assert.equal(runtimeMode({}), 'interactive_shared');
  assert.equal(defaultIpcPort('interactive_shared'), 45009);
  assert.equal(defaultIpcPort('background_unattended'), 45008);
  assert.equal(runtimeMode({ ZHANFU_RUNTIME_MODE: 'background_unattended' }), 'background_unattended');
  assert.throws(() => runtimeMode({ ZHANFU_RUNTIME_MODE: 'other' }), { code: 'zhanfu_runtime_mode_invalid' });
});

test('interactive mode reuses only a service in the active user session', async () => {
  const client = { callWebDriver: async () => ({ ret: 200, returnObj: { success: true } }) };
  const inspectSessions = async (port) => ({ active_session_id: 1, service_session_id: port === 45009 ? 1 : null });
  const result = await ensureZhanFuService(client, { runtimeMode: 'interactive_shared', ipcPort: 45009, inspectSessions });
  assert.deepEqual(result, { serviceMode: 'reused', runtimeMode: 'interactive_shared', active_session_id: 1, service_session_id: 1 });
  await assert.rejects(ensureZhanFuService(client, { runtimeMode: 'interactive_shared', ipcPort: 45009, inspectSessions: async (port) => ({ active_session_id: 1, service_session_id: port === 45009 ? 0 : null }) }), { code: 'zhanfu_session_mismatch' });
});

test('interactive cold start uses the interactive launcher then verifies its session', async () => {
  let probes = 0; let launched = false;
  const client = { callWebDriver: async () => (++probes > 1 ? { ret: 200, returnObj: { success: true } } : { ret: 500 }) };
  const result = await ensureZhanFuService(client, { runtimeMode: 'interactive_shared', ipcPort: 45009, executablePath: 'C:\\站斧.exe', launchInteractive: async () => { launched = true; }, inspectSessions: async (port) => ({ active_session_id: 1, service_session_id: port === 45009 ? 1 : null }), delay: async () => {} });
  assert.equal(launched, true);
  assert.equal(result.serviceMode, 'started');
});

test('interactive mode adopts a legacy-port service only when it belongs to the active user session', async () => {
  const activeLegacy = async (port) => ({ active_session_id: 1, service_session_id: port === 45008 ? 1 : null });
  assert.equal(await resolveIpcPort('interactive_shared', { inspectSessions: activeLegacy }), 45008);
  const client = { callWebDriver: async () => ({ ret: 200, returnObj: { success: true } }) };
  const result = await ensureZhanFuService(client, { runtimeMode: 'interactive_shared', ipcPort: 45008, inspectSessions: activeLegacy });
  assert.deepEqual(result, { serviceMode: 'reused', runtimeMode: 'interactive_shared', active_session_id: 1, service_session_id: 1 });
});

test('interactive mode does not adopt a legacy-port service from another session', async () => {
  const otherSession = async (port) => ({ active_session_id: 1, service_session_id: port === 45008 ? 0 : null });
  assert.equal(await resolveIpcPort('interactive_shared', { inspectSessions: otherSession }), 45009);
});

test('interactive launcher starts visible ZhanFu in the Hermes user session', async () => {
  let call; const child = { unref() { call.unref = true; } };
  await require('../scripts/common/zhanfu_runtime').launchInInteractiveSession('C:\\ZhanFu\\站斧.exe', ['--httpport=45009'], { spawnProcess: (file, args, options) => { call = { file, args, options }; return child; } });
  assert.equal(call.file, 'C:\\ZhanFu\\站斧.exe'); assert.deepEqual(call.args, ['--httpport=45009']);
  assert.equal(call.options.windowsHide, false); assert.equal(call.options.detached, true); assert.equal(call.unref, true);
});

test('interactive and background ZhanFu modes cannot run at the same time', async () => {
  const client = { callWebDriver: async () => ({ ret: 500 }) };
  await assert.rejects(ensureZhanFuService(client, { runtimeMode: 'interactive_shared', ipcPort: 45009, inspectSessions: async (port) => ({ active_session_id: 1, service_session_id: port === 45008 ? 0 : null }) }), { code: 'zhanfu_mode_conflict' });
});

test('validator rejects missing websocket evidence', () => {
  assert.equal(validateA({ schema_version: 'a_open_shop_v1', status: 'ready' }).status, 'failed');
});
