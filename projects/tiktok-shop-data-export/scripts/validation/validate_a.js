#!/usr/bin/env node
'use strict';

const { writeJsonLine } = require('../common/result');

function validateA(value) {
  const errors = [];
  if (value?.schema_version !== 'a_open_shop_v1') errors.push('schema_version');
  if (value?.status !== 'ready') errors.push('status');
  for (const key of ['shop_alias', 'browser_id', 'shop_platform_name', 'web_socket_debugger_url']) if (typeof value?.[key] !== 'string' || !value[key]) errors.push(key);
  if (!['reused', 'opened'].includes(value?.session_mode)) errors.push('session_mode');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value?.cdp_url || '')) errors.push('cdp_url');
  if (value?.zhanfu_base_url !== undefined && !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.zhanfu_base_url)) errors.push('zhanfu_base_url');
  if (!Number.isFinite(Date.parse(value?.observed_at || ''))) errors.push('observed_at');
  return { schema_version: 'validation_result_v1', component: 'a_open_shop', status: errors.length ? 'failed' : 'passed', errors };
}

async function readStdin(stream = process.stdin) {
  let input = '';
  for await (const chunk of stream) input += chunk;
  return input;
}

async function main() {
  try { const result = validateA(JSON.parse((await readStdin()).trim())); writeJsonLine(result); return result.status === 'passed' ? 0 : 2; }
  catch { writeJsonLine({ schema_version: 'validation_result_v1', component: 'a_open_shop', status: 'failed', errors: ['invalid_json'] }); return 2; }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { validateA };
