'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const toolEntry = require('../scripts/i_hermes_tool_export');

function result(status, reports) {
  return {
    schema_version: 'export_result_v1', request_id: 'request-1', status, shop_id: '123',
    report_ids: reports.map((item) => item.report_id), reports,
  };
}

async function run(request, executeExport) {
  const lines = [];
  const code = await toolEntry.main(['--request-json', JSON.stringify(request)], {
    executeExport, writeLine: (line) => lines.push(line),
  });
  return { code, events: lines.map((line) => JSON.parse(line.slice(toolEntry.PREFIX.length))) };
}

test('Hermes passes one v3 request unchanged and preserves report and artifact terminals', async () => {
  const request = {
    shop: '店铺 A', report_scopes: ['report:inventory_snapshot', 'scope:campaign_products'],
    start_date: '2026-08-01', end_date: '2026-08-02', advertiser: '100', campaign: '200', product: '300',
  };
  let received;
  const report = {
    report_id: 'multi', status: 'partial', files: ['D:\\one.xlsx'], data_row_count: 2,
    reason_code: 'one_artifact_failed',
    artifacts: [
      { status: 'success', output_file: 'D:\\one.xlsx', data_row_count: 2, sha256: 'a'.repeat(64) },
      { status: 'failed', files: [], data_row_count: 0, reason_code: 'download_failed' },
    ],
  };
  const { code, events } = await run(request, async (value) => { received = value; return result('partial', [report]); });
  assert.deepEqual(received, request);
  assert.equal(code, 2);
  assert.deepEqual(events[0], { event: 'ack', status: 'accepted' });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { ...result('partial', [report]), event: 'final' });
});

test('Hermes preserves all four aggregate statuses without folding no_data', async () => {
  for (const status of ['success', 'no_data', 'partial', 'failed']) {
    const report = {
      report_id: 'inventory_snapshot', status, files: status === 'failed' ? [] : ['D:\\inventory.xlsx'],
      data_row_count: status === 'success' ? 1 : 0,
      ...(status === 'failed' ? { reason_code: 'source_unavailable' } : {}),
    };
    const output = await run({ shop: '店铺 A', report_scopes: ['inventory_snapshot'] }, async () => result(status, [report]));
    assert.equal(output.events.length, 2, status);
    assert.equal(output.events[1].event, 'final', status);
    assert.equal(output.events[1].status, status, status);
    assert.deepEqual(output.events[1].reports, [report], status);
    assert.equal(output.code, ['success', 'no_data'].includes(status) ? 0 : 2, status);
  }
});

test('invalid JSON returns one failed final without ACK', async () => {
  let executions = 0; const lines = [];
  const code = await toolEntry.main(['--request-json', '{bad'], {
    executeExport: async () => { executions += 1; }, writeLine: (line) => lines.push(line),
  });
  assert.equal(code, 2);
  assert.equal(executions, 0);
  assert.equal(lines.length, 1);
  const final = JSON.parse(lines[0].slice(toolEntry.PREFIX.length));
  assert.equal(final.event, 'final');
  assert.equal(final.status, 'failed');
  assert.equal(final.reason_code, 'request_json_invalid');
});

test('unknown disabled and wide scopes fail before session creation', async () => {
  for (const scope of ['unknown-report', 'affiliate_performance_overview', 'all', 'default']) {
    let sessions = 0; const lines = [];
    const code = await toolEntry.main(['--request-json', JSON.stringify({ shop: '店铺 A', report_scopes: [scope] })], {
      exportDependencies: { createRunSession: async () => { sessions += 1; throw new Error('must_not_open'); } },
      writeLine: (line) => lines.push(line),
    });
    assert.equal(code, 2, scope);
    assert.equal(sessions, 0, scope);
    assert.equal(lines.length, 2, scope);
    const final = JSON.parse(lines[1].slice(toolEntry.PREFIX.length));
    assert.equal(final.event, 'final', scope);
    assert.equal(final.status, 'failed', scope);
    assert.equal(final.request_id, null, scope);
  }
});

test('missing required report dates preserves the pre-session failure reason', async () => {
  let sessions = 0; const lines = [];
  const code = await toolEntry.main(['--request-json', JSON.stringify({
    shop: '店铺 A', report_scopes: ['店铺商品每日表现'],
  })], {
    exportDependencies: { createRunSession: async () => { sessions += 1; throw new Error('must_not_open'); } },
    writeLine: (line) => lines.push(line),
  });
  assert.equal(code, 2);
  assert.equal(sessions, 0);
  assert.equal(lines.length, 2);
  const final = JSON.parse(lines[1].slice(toolEntry.PREFIX.length));
  assert.equal(final.event, 'final');
  assert.equal(final.reason_code, 'date_range_required');
});

test('Skill exposes only the lightweight entry and keeps cleaning separate', () => {
  const root = path.resolve(__dirname, '..');
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  assert.match(skill, /node scripts\/export\.js --request-json/u);
  assert.match(skill, /Never invoke or chain the cleaning Skill/u);
});
