'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { captureOfficialPageCurrency } = require('../../common/currency-contract');
const { countXlsxDataRows } = require('../../common/official_download_rows');
const { assertExportControlReady } = require('../../common/official_ui_control');
const { dismissBlockingOverlay, validateBlockingOverlay } = require('../../common/ui-blocking-overlay');

const SAFE_TASK_ID = /^[A-Za-z0-9]+$/u;

function fail(code, diagnostics = null) { throw Object.assign(new Error(code), { code }, diagnostics ? { diagnostics } : {}); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function validDate(value) { const parsed = new Date(`${value}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || '')) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === value; }
function activePage(page, origin) { try { const url = new URL(page.url()); return url.origin === origin && !/(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function displayedRange(start, end) { const display = (value) => `${Number(value.slice(0,4))}/${Number(value.slice(5,7))}/${Number(value.slice(8,10))}`; return `${display(start)} - ${display(end)}`; }

function validateSpec(spec, providerSpec, options = {}) {
  try { validateReportSpec(spec, options); } catch { fail('affiliate_report_spec_invalid'); }
  const rules = providerSpec?.official_validation; const calendar = rules?.calendar; const retry = providerSpec?.retry_policy;
  if (spec?.report_id !== 'affiliate_center_performance' || spec.no_data_rule !== 'not_applicable'
    || spec.providers?.local !== providerSpec || providerSpec?.transport !== 'official_ui_download'
    || !object(rules) || !object(calendar) || !object(retry) || !validateBlockingOverlay(rules.blocking_overlay)) fail('affiliate_report_spec_invalid');
  let providerOrigin; try { providerOrigin = new URL(providerSpec.origin); } catch { fail('affiliate_report_spec_invalid'); }
  if (providerOrigin.protocol !== 'https:' || providerOrigin.origin !== providerSpec.origin) fail('affiliate_report_spec_invalid');
  for (const field of ['create_endpoint','export_endpoint']) if (!/^\/[a-z0-9_/-]+$/u.test(rules[field])) fail('affiliate_report_spec_invalid');
  for (const field of ['details_card_title_pattern','date_value_pattern','export_button_pattern','export_locator','empty_state_pattern','task_id_pattern','seller_query','task_query']) if (!text(rules[field])) fail('affiliate_report_spec_invalid');
  for (const field of ['dropdown_selector','option_selector','panel_selector','header_selector','left_control_selector','right_control_selector','cell_any_selector','cell_selector']) if (!text(calendar[field])) fail('affiliate_report_spec_invalid');
  let sellerOrigin; try { sellerOrigin = new URL(rules.seller_origin); } catch { fail('affiliate_report_spec_invalid'); }
  if (sellerOrigin.protocol !== 'https:' || sellerOrigin.origin !== rules.seller_origin
    || rules.seller_landing_path !== '/affiliate/landing' || !text(rules.seller_landing_button)
    || !Array.isArray(rules.navigation_steps) || rules.navigation_steps.length !== 3 || rules.navigation_steps.some((value) => !text(value))
    || !text(rules.shop_region) || !object(rules.entry_query_fields) || !text(rules.entry_query_fields.shop_id) || !text(rules.entry_query_fields.shop_region)
    || !object(rules.response_paths) || !Array.isArray(rules.response_paths.create_task_id) || !rules.response_paths.create_task_id.every(text)
    || !Number.isInteger(rules.data_start_row) || rules.data_start_row < 1
    || !Number.isInteger(calendar.option_count) || calendar.option_count < 1 || !Number.isInteger(calendar.custom_option_index) || calendar.custom_option_index < 0 || calendar.custom_option_index >= calendar.option_count
    || !Number.isInteger(calendar.panel_count) || calendar.panel_count < 1 || !Number.isInteger(calendar.max_month_moves) || calendar.max_month_moves < 1
    || retry.max_total_attempts !== 1 || !Array.isArray(retry.retryable) || retry.retryable.length || !Array.isArray(retry.non_retryable)
    || !Number.isInteger(rules.request_timeout_ms) || rules.request_timeout_ms < 1 || !Number.isInteger(rules.page_stability_poll_ms) || rules.page_stability_poll_ms < 1
    || !Number.isInteger(rules.calendar_ready_timeout_ms) || rules.calendar_ready_timeout_ms < 1 || !Number.isInteger(rules.download_timeout_ms) || rules.download_timeout_ms < 1) fail('affiliate_report_spec_invalid');
  for (const source of [...rules.navigation_steps,rules.details_card_title_pattern,rules.date_value_pattern,rules.export_button_pattern,rules.empty_state_pattern]) try { new RegExp(source,'u'); } catch { fail('affiliate_report_spec_invalid'); }
  let taskPattern; try { taskPattern = new RegExp(rules.task_id_pattern,'u'); } catch { fail('affiliate_report_spec_invalid'); }
  if (taskPattern.test('') || taskPattern.test('_') || !taskPattern.test('A1z9')) fail('affiliate_report_spec_invalid');
  return spec;
}

function assertBorrowedSession(input, dependencies, rules) {
  if (!dependencies.browser?.isConnected?.()) fail('browser_disconnected');
  if (!dependencies.browserContext || !dependencies.browser.contexts?.().includes(dependencies.browserContext)) fail('browser_context_missing');
  let sellerOrigin; try { sellerOrigin = new URL(input.b.seller_page_url).origin; } catch { fail('provider_binding_invalid'); }
  if (sellerOrigin !== rules.seller_origin) fail('provider_binding_invalid');
  const pages = dependencies.browserContext.pages?.() || [];
  if (pages.some((page) => activePage(page, sellerOrigin))) return;
  if (pages.some((page) => { try { const url = new URL(page.url()); return url.origin === sellerOrigin && /(?:login|signin)(?:\/|$)/iu.test(url.pathname); } catch { return false; } })) fail('seller_login_page');
  fail('seller_origin_mismatch');
}

async function clickNavigationStep(page, pattern, stage = 'navigation', clickOptions = {}) {
  try {
    const matches = page.getByText(new RegExp(pattern, 'u'), { exact:true }); const visible = []; const clickable = new Map();
    for (let index = 0; index < await matches.count(); index += 1) {
      const item = matches.nth(index); if (!await item.isVisible()) continue; visible.push(item);
      const ancestor = item.locator('xpath=ancestor-or-self::*[self::a or self::button or @role="menuitem" or @role="link"][1]');
      if (await ancestor.count() === 1) {
        const key = await ancestor.evaluate((element) => {
          const parts=[];for(let current=element;current;current=current.parentElement){const siblings=current.parentElement?[...current.parentElement.children]:[current];parts.push(`${current.tagName}:${siblings.indexOf(current)}`);}return parts.reverse().join('/');
        });
        if (!clickable.has(key)) clickable.set(key, ancestor);
      }
    }
    const targets=[...clickable.values()];const target = targets.length === 1 ? targets[0] : visible.length === 1 ? visible[0] : null;
    if (!target) fail('affiliate_navigation_changed', { stage });
    if (clickOptions.native === true && typeof target.evaluate === 'function') {
      await target.evaluate((element) => element.click());
    } else {
      const { native: _native, ...playwrightOptions } = clickOptions;
      await target.click(playwrightOptions);
    }
  } catch (error) {
    if (error?.code) throw error;
    fail('affiliate_navigation_click_failed', { stage, error_name:String(error?.name || 'Error') });
  }
}

async function navigateAffiliate(input, dependencies, rules, origin, pause) {
  const dismiss = dependencies.dismissBlockingOverlay || dismissBlockingOverlay;
  const seller = dependencies.browserContext.pages().find((page) => activePage(page, rules.seller_origin));
  if (!seller) fail('seller_page_missing');
  const before = new Map(dependencies.browserContext.pages().map((page) => [page, page.url()]));
  await dismiss(seller, rules.blocking_overlay);
  await clickNavigationStep(seller, rules.navigation_steps[0], 'seller_affiliate', { native:true, noWaitAfter:true });
  await pause(rules.page_stability_poll_ms);
  const deadline = Date.now() + rules.request_timeout_ms; let page = null; let landingClicked = false;
  while (Date.now() < deadline) {
    page = dependencies.browserContext.pages().find((candidate) => activePage(candidate, origin) && (!before.has(candidate) || before.get(candidate) !== candidate.url())) || null;
    if (page) break;
    const current = new URL(seller.url());
    if (!landingClicked && current.origin === rules.seller_origin && current.pathname === rules.seller_landing_path) {
      const region = current.searchParams.get(rules.entry_query_fields.shop_region);
      if (region && region !== rules.shop_region) fail('result_shop_identity_mismatch');
      const button = seller.getByRole('button', { name:rules.seller_landing_button, exact:true });
      if (await button.count() === 1 && await button.isVisible()) {
        await dismiss(seller, rules.blocking_overlay);
        landingClicked = true;
        await button.click({ noWaitAfter:true, timeout:rules.request_timeout_ms });
      }
    }
    await pause(rules.page_stability_poll_ms);
  }
  if (!page) fail('affiliate_navigation_timeout', { stage:landingClicked ? 'affiliate_after_landing' : 'seller_affiliate' });
  assertAffiliatePage(page, origin, input.shop.seller_id, rules);
  await dismiss(page, rules.blocking_overlay);
  await waitNavigationReady(page, rules.navigation_steps[1], rules.request_timeout_ms, 'affiliate_analytics');
  await clickNavigationStep(page, rules.navigation_steps[1], 'affiliate_analytics');
  await dismiss(page, rules.blocking_overlay);
  await waitNavigationReady(page, rules.navigation_steps[2], rules.request_timeout_ms, 'affiliate_performance');
  await clickNavigationStep(page, rules.navigation_steps[2], 'affiliate_performance');
  await dismiss(page, rules.blocking_overlay);
  assertAffiliatePage(page, origin, input.shop.seller_id, rules);
  return page;
}

async function waitNavigationReady(page, pattern, timeout, stage) {
  try { await page.getByText(new RegExp(pattern, 'u'), { exact:true }).first().waitFor({ state:'visible', timeout }); }
  catch (error) { fail('affiliate_navigation_timeout', { stage, error_name:String(error?.name || 'Error') }); }
}

function assertAffiliatePage(page, origin, sellerId, rules) {
  let url; try { url = new URL(page.url()); } catch { fail('provider_binding_invalid'); }
  if (/(?:login|signin)(?:\/|$)/iu.test(url.pathname)) fail('transport_login_required');
  if (url.origin !== origin) fail('provider_binding_invalid');
  if (url.searchParams.get(rules.entry_query_fields.shop_id) !== String(sellerId) || url.searchParams.get(rules.entry_query_fields.shop_region) !== rules.shop_region) fail('result_shop_identity_mismatch');
}

function parseMonth(value) { const match = String(value || '').trim().match(/^(\d{4})(?:-|年\s*-\s*)(\d{1,2})(?:月)?$/u); return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null; }
async function visiblePanels(page, calendar, rules, pause) {
  const panels = page.locator(calendar.panel_selector); const deadline = Date.now() + rules.calendar_ready_timeout_ms;
  while (await panels.count() !== calendar.panel_count && Date.now() < deadline) await pause(rules.page_stability_poll_ms);
  if (await panels.count() !== calendar.panel_count) fail('affiliate_calendar_panel_count_mismatch'); const result = [];
  for (let index = 0; index < calendar.panel_count; index += 1) { const panel = panels.nth(index); const month = parseMonth(await panel.locator(calendar.header_selector).innerText()); if (month === null) fail('affiliate_calendar_header_unreadable'); result.push({ panel, month }); }
  return result;
}
async function selectDate(page, date, calendar, rules, pause, stage = 'date') {
  const target = Number(date.slice(0,4)) * 12 + Number(date.slice(5,7)) - 1; let selected;
  for (let attempt = 0; attempt < calendar.max_month_moves; attempt += 1) {
    const panels = await visiblePanels(page, calendar, rules, pause); selected = panels.find((item) => item.month === target); if (selected) break;
    const backwards = target < panels[0].month; const panel = backwards ? panels[0].panel : panels[panels.length - 1].panel; const control = panel.locator(backwards ? calendar.left_control_selector : calendar.right_control_selector).locator('..');
    if (await control.count() !== 1) fail('affiliate_calendar_navigation_changed'); await control.click(); await pause(rules.page_stability_poll_ms);
  }
  if (!selected) fail('affiliate_calendar_month_unreachable'); const day = String(Number(date.slice(8,10))); const dayPattern=new RegExp(`^0?${day}$`,'u'); const allCells=selected.panel.locator(calendar.cell_any_selector).filter({hasText:dayPattern}); const cell = selected.panel.locator(calendar.cell_selector).filter({hasText:dayPattern}); const candidateCount=await allCells.count(); const count = await cell.count();
  if (count === 0) fail('affiliate_date_range_not_selectable', { stage, requested_date:date, candidate_count:candidateCount, exact_match_count:count }); if (count !== 1) fail('affiliate_calendar_day_ambiguous', { stage, requested_date:date }); await cell.click(); await pause(rules.page_stability_poll_ms);
}

async function dateControl(region, rules, pause) {
  const pattern = new RegExp(rules.date_value_pattern,'u'); const deadline = Date.now() + rules.request_timeout_ms;
  while (Date.now() < deadline) {
    const candidates = region.locator('div:visible').filter({ hasText:pattern }); const leaves = [];
    for (let index = 0; index < await candidates.count(); index += 1) { const candidate = candidates.nth(index); if (await candidate.locator(':scope > *').count() === 0) leaves.push(candidate); }
    if (leaves.length === 1) return leaves[0]; await pause(rules.page_stability_poll_ms);
  }
  fail('affiliate_date_control_changed');
}

async function structuralCard(title, rules) {
  if (!await title.isVisible()) return null;
  const match = await title.evaluate((element, patterns) => {
    const datePattern = new RegExp(patterns.date, 'u'); const buttonPattern = new RegExp(patterns.button, 'u');
    const normalized = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
    const visible = (node) => { const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && node.getClientRects().length > 0; };
    const keyFor = (node) => { const parts = []; for (let current = node; current; current = current.parentElement) { const siblings = current.parentElement ? [...current.parentElement.children] : [current]; parts.push(`${current.tagName.toLowerCase()}:${siblings.indexOf(current)}`); } return parts.reverse().join('/'); };
    let depth = 1;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement, depth += 1) {
      const dates = [...ancestor.querySelectorAll('div')].filter((node) => visible(node) && node.children.length === 0 && datePattern.test(normalized(node.innerText || node.textContent)));
      const buttons = [...ancestor.querySelectorAll('button')].filter((node) => visible(node) && buttonPattern.test(normalized(node.innerText || node.textContent)));
      if (dates.length === 1 && buttons.length === 1) return { depth, key:keyFor(ancestor) };
    }
    return null;
  }, { date:rules.date_value_pattern, button:rules.export_button_pattern });
  if (!match) return null; let card = title; for (let depth = 0; depth < match.depth; depth += 1) card = card.locator('xpath=..'); return { card, key:match.key };
}

async function resolveDetailsCard(page, rules, pause) {
  const deadline = Date.now() + rules.request_timeout_ms; let last = []; let stableKey = null; let stableCount = 0;
  do {
    const titles = page.getByText(new RegExp(rules.details_card_title_pattern,'u'), { exact:true }); const cards = new Map();
    for (let index = 0; index < await titles.count(); index += 1) { const candidate = await structuralCard(titles.nth(index), rules); if (candidate && !cards.has(candidate.key)) cards.set(candidate.key, candidate.card); }
    last = [...cards.entries()];
    if (last.length === 1) { const [key, card] = last[0]; stableCount = key === stableKey ? stableCount + 1 : 1; stableKey = key; if (stableCount >= 2) return card; } else { stableKey = null; stableCount = 0; }
    if (Date.now() >= deadline) break; await pause(rules.page_stability_poll_ms);
  } while (true);
  if (last.length > 1) fail('affiliate_details_card_ambiguous'); fail('affiliate_details_card_missing');
}

async function applyDateRange(page, region, start, end, rules, pause) {
  const control = await dateControl(region, rules, pause); await control.click(); const calendar = rules.calendar; const dropdown = page.locator(calendar.dropdown_selector).last();
  await dropdown.waitFor({ state:'visible', timeout:rules.request_timeout_ms }); const options = dropdown.locator(calendar.option_selector);
  if (await options.count() !== calendar.option_count) fail('affiliate_date_preset_changed'); const custom = options.nth(calendar.custom_option_index).locator('..'); await custom.hover();
  if (await page.locator(calendar.panel_selector).count() !== calendar.panel_count) await custom.click();
  await visiblePanels(page, calendar, rules, pause); await selectDate(page, start, calendar, rules, pause, 'start_date'); await selectDate(page, end, calendar, rules, pause, 'end_date');
  const expected = displayedRange(start, end); const deadline = Date.now() + rules.request_timeout_ms;
  while (Date.now() < deadline) { if (String(await (await dateControl(region, rules, pause)).innerText()).trim() === expected) return expected; await pause(rules.page_stability_poll_ms); }
  fail('affiliate_date_application_not_observed');
}

async function downloadBuffer(download) { const stream = await download.createReadStream(); if (!stream) fail('official_download_missing'); const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

async function runInner(input, dependencies = {}) {
  if (input?.shop?.provider_id !== 'local') fail('report_provider_unsupported');
  validateSpec(input?.reportSpec, input?.providerSpec, { skillRoot:dependencies.skillRoot }); const rules = input.providerSpec.official_validation;
  if (!object(input.a) || !object(input.b) || !object(input.shop) || !/^\d+$/u.test(String(input.shop.seller_id || ''))
    || !validDate(input.startDate) || !validDate(input.endDate) || input.startDate > input.endDate || !dependencies.browser || !dependencies.browserContext) fail('affiliate_input_invalid');
  const origin = input.providerSpec.origin; const outputDir = path.resolve(String(input.outputDir || ''));
  if (!fs.statSync(outputDir, { throwIfNoEntry:false })?.isDirectory() || fs.readdirSync(outputDir).length) fail('output_directory_invalid');
  assertBorrowedSession(input, dependencies, rules); let page = null; const pause = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    page = await (dependencies.navigateAffiliate || navigateAffiliate)(input, dependencies, rules, origin, pause); assertAffiliatePage(page, origin, input.shop.seller_id, rules);
    const region = await (dependencies.resolveDetailsCard || resolveDetailsCard)(page, rules, pause); const button = region.locator(rules.export_locator); await assertExportControlReady(button, 'affiliate_export_control_not_ready', { wait:true, timeoutMs:rules.request_timeout_ms });
    await (dependencies.applyDateRange || applyDateRange)(page, region, input.startDate, input.endDate, rules, pause);
    await (dependencies.dismissBlockingOverlay || dismissBlockingOverlay)(page, rules.blocking_overlay);
    const empty = new RegExp(rules.empty_state_pattern,'u').test(await region.innerText()); const disabled = await button.isDisabled();
    if (empty !== disabled) fail('affiliate_empty_state_contract_mismatch'); if (empty) fail('affiliate_official_zero_signal_unavailable'); await assertExportControlReady(button, 'affiliate_export_control_not_ready');
    const createPromise = page.waitForResponse((response) => { try { const url = new URL(response.url()); return response.request().method() === 'POST' && url.origin === origin && url.pathname === rules.create_endpoint; } catch { return false; } }, { timeout:rules.request_timeout_ms });
    const exportPromise = page.waitForRequest((request) => { try { const url = new URL(request.url()); return request.method() === 'GET' && url.origin === origin && url.pathname === rules.export_endpoint; } catch { return false; } }, { timeout:rules.download_timeout_ms });
    const downloadPromise = page.waitForEvent('download', { timeout:rules.download_timeout_ms }); await button.click(); const [createResponse, exportRequest, download] = await Promise.all([createPromise, exportPromise, downloadPromise]);
    assertAffiliatePage(page, origin, input.shop.seller_id, rules);
    const create = await createResponse.json().catch(() => null); const taskId = String(rules.response_paths.create_task_id.reduce((value, key) => value?.[key], create) || '');
    if (createResponse.status() !== 200 || create?.code !== 0 || !SAFE_TASK_ID.test(taskId) || !(new RegExp(rules.task_id_pattern,'u')).test(taskId)) fail('affiliate_export_task_changed');
    const requestUrl = new URL(exportRequest.url()); if (requestUrl.searchParams.get(rules.task_query) !== taskId || requestUrl.searchParams.get(rules.seller_query) !== String(input.shop.seller_id) || requestUrl.searchParams.get(rules.entry_query_fields.shop_region) !== rules.shop_region) fail('affiliate_export_task_binding_mismatch');
    const buffer = await downloadBuffer(download); const dataRowCount = countXlsxDataRows(buffer, rules.data_start_row); const hash = sha256(buffer); const outputFile = path.join(outputDir, `${taskId}.xlsx`);
    fs.writeFileSync(outputFile, buffer, { flag:'wx' }); if (sha256(fs.readFileSync(outputFile)) !== hash) fail('official_file_changed');
    const currencyEvidence = await captureOfficialPageCurrency(region, input.reportSpec.currency_contract, dependencies);
    return { schema_version:'affiliate_center_performance_v3', status:'success', shop_id:String(input.shop.seller_id), seller_id:String(input.shop.seller_id), oec_seller_id:String(input.shop.seller_id), provider_id:'local', task_id:taskId, output_file:outputFile, byte_length:buffer.length, sha256:hash, official_file_unchanged:true, data_row_count:dataRowCount, currency_evidence:currencyEvidence };
  } catch (error) { if (page) assertAffiliatePage(page, origin, input.shop.seller_id, rules); throw error; }
}

module.exports = { applyDateRange, clickNavigationStep, navigateAffiliate, resolveDetailsCard, run:runInner, validateSpec };
