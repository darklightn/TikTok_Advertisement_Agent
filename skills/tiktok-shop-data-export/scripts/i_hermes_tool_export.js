#!/usr/bin/env node
'use strict';

const { executeExport } = require('./export');

const PREFIX = 'TIKTOK_GMV_MAX_TOOL ';
const TERMINAL_STATUSES = new Set(['success', 'no_data', 'partial', 'failed']);

function codedError(code) { return Object.assign(new Error(code), { code }); }
function failedResult(reasonCode) {
  return {
    schema_version: 'export_result_v1', request_id: null, status: 'failed', shop_id: null,
    report_ids: [], reports: [], reason_code: reasonCode,
  };
}
function parseCliArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--request-json') throw codedError('invalid_arguments');
  try { return JSON.parse(argv[1]); } catch { throw codedError('request_json_invalid'); }
}
function writeEvent(event, dependencies = {}) {
  const line = `${PREFIX}${JSON.stringify(event)}\n`;
  (dependencies.writeLine || ((value) => process.stdout.write(value)))(line);
}
function finalEvent(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !TERMINAL_STATUSES.has(result.status) || !Array.isArray(result.report_ids)
    || !Array.isArray(result.reports)) throw codedError('export_result_invalid');
  return { ...result, event: 'final' };
}
function exitAfterStdoutFlush(code, runtime = process) {
  runtime.stdout.write('', () => runtime.exit(code));
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let request;
  try { request = parseCliArgs(argv); }
  catch (error) {
    writeEvent(finalEvent(failedResult(error.code || 'invalid_arguments')), dependencies);
    return 2;
  }

  writeEvent({ event: 'ack', status: 'accepted' }, dependencies);
  let result;
  try { result = await (dependencies.executeExport || executeExport)(request, dependencies.exportDependencies); }
  catch (error) { result = failedResult(error.code || 'export_failed'); }
  try { result = finalEvent(result); }
  catch (error) { result = finalEvent(failedResult(error.code || 'export_result_invalid')); }
  writeEvent(result, dependencies);
  return ['success', 'no_data'].includes(result.status) ? 0 : 2;
}

if (require.main === module) main().then((code) => exitAfterStdoutFlush(code));
module.exports = { PREFIX, exitAfterStdoutFlush, finalEvent, main, parseCliArgs, writeEvent };
