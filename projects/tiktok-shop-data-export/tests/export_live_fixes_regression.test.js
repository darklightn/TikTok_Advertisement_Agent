'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadReportMd } = require('../scripts/load-report-md');

const ROOT = path.resolve(__dirname, '..');

function response(provider, pathname, method, body) {
  return {
    url: () => `${provider.task_response_origin}${pathname}`,
    request: () => ({ method: () => method }),
    status: () => 200,
    json: async () => body,
  };
}

test('promotion date application no longer waits for a statistics response', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/routes/cross_border/shop_promotion_performance.js'), 'utf8');
  assert.equal(source.includes('promotion_date_refresh_not_ready'), false);
  assert.equal(source.includes('applyDateRangeAndWaitForRefresh'), false);
});

test('affiliate single-day range selects both range endpoints for both providers', () => {
  for (const providerId of ['cross_border', 'local']) {
    const source = fs.readFileSync(path.join(ROOT, `scripts/routes/${providerId}/affiliate_center_performance.js`), 'utf8');
    assert.equal(source.includes('if (end !== start) await selectDate'), false, providerId);
    assert.match(source, /selectDate\(page, start,[^;]+; await selectDate\(page, end,/u, providerId);
    assert.equal(source.includes('^0?${day}$'), true, providerId);
  }
});

test('orders keep task ID binding while accepting known and fallback creation response shapes', async () => {
  const spec = loadReportMd().specs.manage_orders_csv;
  const { waitForCreatedTask } = require('../scripts/routes/common/manage_orders_task_binding');
  for (const providerId of ['cross_border', 'local']) {
    const provider = spec.providers[providerId]; const rules = provider.official_validation; const ui = rules.ui_contract;
    for (const [candidate, expectedKnown] of [
      [response(provider, rules.create_endpoint, ui.create_method, { code: 0, data: { export_task_id: 1002 } }), true],
      [response(provider, '/api/new/export/create', 'PUT', { success: true, result: { task_id: 'task-A_2' } }), false],
    ]) {
      const page = { waitForResponse: async (predicate) => { assert.equal(await predicate(candidate), true); return candidate; } };
      const selected = await waitForCreatedTask(page, provider, 1000, ui, () => true, async () => {});
      assert.equal(selected.taskId, expectedKnown ? '1002' : 'task-A_2', providerId);
      assert.equal(selected.known_contract, expectedKnown, providerId);
    }
    const ambiguous = response(provider, '/api/new/export/create', 'PUT', { task_id: 'task-A', nested: { export_task_id: 'task-B' } });
    const ambiguousPage = { waitForResponse: async (predicate) => { assert.equal(await predicate(ambiguous), true); return ambiguous; } };
    const ambiguousSelected = await waitForCreatedTask(ambiguousPage, provider, 1000, ui, () => true, async () => {});
    assert.equal(ambiguousSelected.taskId, 'task-A', providerId);
    const recordList = response(provider, rules.record_endpoint, ui.record_method || 'POST', { data: { export_records: [{ export_task_id: 'historical-task' }] } });
    const { analyzeCreateResponse } = require('../scripts/routes/common/manage_orders_task_binding');
    assert.equal(await analyzeCreateResponse(recordList, provider, rules, ui), null, providerId);
    const source = fs.readFileSync(path.join(ROOT, provider.runner), 'utf8');
    assert.doesNotMatch(source, /existingTaskIds\.has\(taskId\)/u, providerId);
    assert.match(source, /waitTask\(page,providerSpec,taskId|waitTask\(page, providerSpec, taskId/u, providerId);
  }
});
