'use strict';

function fail(code) { throw Object.assign(new Error(code), { code }); }
function object(value) { return value && typeof value === 'object'; }
function getPath(value, fields) { return fields.reduce((current, field) => current?.[field], value); }

function collectNamedTaskIds(value, allowedKeys, taskPattern, result = new Set(), depth = 0) {
  if (!object(value) || depth > 8) return result;
  if (Array.isArray(value)) {
    for (const item of value) collectNamedTaskIds(item, allowedKeys, taskPattern, result, depth + 1);
    return result;
  }
  for (const [key, item] of Object.entries(value)) {
    if (allowedKeys.has(key) && (typeof item === 'string' || typeof item === 'number')) {
      const candidate = String(item).trim(); if (taskPattern.test(candidate)) result.add(candidate);
    }
    collectNamedTaskIds(item, allowedKeys, taskPattern, result, depth + 1);
  }
  return result;
}

async function analyzeCreateResponse(response, providerSpec, rules, ui) {
  let request; let url;
  try { request = response.request(); url = new URL(response.url()); } catch { return null; }
  if (url.origin !== providerSpec.task_response_origin || response.status() !== 200) return null;
  if (url.pathname === rules.list_endpoint || url.pathname === rules.record_endpoint) return null;
  const body = await response.json().catch(() => null); if (!object(body) || body.code !== undefined && body.code !== 0) return null;
  const taskPattern = new RegExp(ui.task_id_pattern, 'u'); const ids = collectNamedTaskIds(body, new Set(ui.task_id_candidate_keys), taskPattern);
  const contracted = getPath(body, ui.response_paths.create_task_id); let preferredId = null;
  if (typeof contracted === 'string' || typeof contracted === 'number') { const candidate = String(contracted).trim(); if (taskPattern.test(candidate)) { ids.add(candidate); preferredId = candidate; } }
  if (!ids.size) return null;
  return { ids: [...ids], preferredId, known_contract: request.method() === ui.create_method && url.pathname === rules.create_endpoint };
}

async function waitForCreatedTask(page, providerSpec, timeout, ui, isArmed, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const rules = providerSpec.official_validation; let selected = null;
  try {
    await page.waitForResponse(async (candidate) => {
      if (!isArmed()) return false;
      const analysis = await analyzeCreateResponse(candidate, providerSpec, rules, ui); if (!analysis) return false;
      selected = { taskId:analysis.preferredId || analysis.ids[0], known_contract:analysis.known_contract };
      await delay(Math.min(50, ui.create_fallback_grace_ms));
      return true;
    }, { timeout });
  } catch (error) { if (error?.name === 'TimeoutError') fail('export_task_response_not_observed'); throw error; }
  if (!selected) fail('export_task_response_not_observed');
  return selected;
}

async function waitForTaskRecord(page, providerSpec, taskIdPromise, timeout, ui, isArmed) {
  const rules = providerSpec.official_validation; let selected = null; let ambiguous = false;
  try {
    await page.waitForResponse(async (response) => {
      if (!isArmed()) return false;
      let url; try { url = new URL(response.url()); } catch { return false; }
      if (url.origin !== providerSpec.task_response_origin || url.pathname !== rules.record_endpoint
        || ui.record_method && response.request().method() !== ui.record_method || response.status() !== 200) return false;
      const taskId = await taskIdPromise; const body = await response.json().catch(() => null);
      const records = getPath(body, ui.response_paths.record_items); if (!Array.isArray(records)) return false;
      const matches = records.filter((item) => String(getPath(item, ui.response_paths.record_task_id)) === taskId);
      if (matches.length > 1) { ambiguous = true; return true; }
      if (getPath(matches[0], ui.response_paths.record_file_key)) { selected = matches[0]; return true; }
      return false;
    }, { timeout });
  } catch (error) { if (error?.name === 'TimeoutError') fail('export_task_timeout'); throw error; }
  if (ambiguous) fail('export_record_ambiguous');
  if (!selected) fail('export_task_timeout');
  return selected;
}

module.exports = { analyzeCreateResponse, collectNamedTaskIds, waitForCreatedTask, waitForTaskRecord };
