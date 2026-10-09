#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { writeJsonLine } = require('../common/result');

function validateB(value, aResult) {
  const errors = [];
  if (value?.schema_version !== 'b_attach_shop_v1') errors.push('schema_version');
  if (value?.status !== 'operable') errors.push('status');
  if (value?.seller_page_found !== true) errors.push('seller_page_found');
  if (value?.identity_match !== true) errors.push('identity_match');
  if (value?.page_read_probe !== 'passed') errors.push('page_read_probe');
  if (value?.mutation_attempted !== false) errors.push('mutation_attempted');
  if (!['interactive', 'complete'].includes(value?.document_ready_state)) errors.push('document_ready_state');
  if (!/^https:\/\//.test(value?.seller_page_url || '')) errors.push('seller_page_url');
  if (value?.identity_anchor?.source !== 'zhanfu_extension') errors.push('identity_anchor');
  if (aResult) {
    if (value?.requested_shop_alias !== aResult.shop_alias) errors.push('a_shop_alias');
    if (String(value?.browser_id) !== String(aResult.browser_id)) errors.push('a_browser_id');
    if (value?.cdp_url !== aResult.cdp_url) errors.push('a_cdp_url');
  }
  return { schema_version: 'validation_result_v1', component: 'b_attach_shop', status: errors.length ? 'failed' : 'passed', errors };
}

async function readStdin() { let input = ''; for await (const chunk of process.stdin) input += chunk; return input; }
function parseJson(text) { return JSON.parse(String(text).replace(/^\uFEFF/, '').trim()); }
function readJsonFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf16le' : 'utf8';
  return parseJson(buffer.toString(encoding));
}
async function main(argv = process.argv.slice(2)) {
  try {
    const aIndex = argv.indexOf('--a-result');
    const bIndex = argv.indexOf('--b-result');
    const aResult = aIndex >= 0 ? readJsonFile(argv[aIndex + 1]) : null;
    const bResult = bIndex >= 0 ? readJsonFile(argv[bIndex + 1]) : parseJson(await readStdin());
    const result = validateB(bResult, aResult); writeJsonLine(result); return result.status === 'passed' ? 0 : 2;
  } catch { writeJsonLine({ schema_version: 'validation_result_v1', component: 'b_attach_shop', status: 'failed', errors: ['invalid_input'] }); return 2; }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });
module.exports = { parseJson, readJsonFile, validateB };
