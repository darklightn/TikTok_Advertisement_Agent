'use strict';
const PROVIDER_ID = 'cross_border';
const fs = require('fs'); const path = require('path');
const { resolveDateRange } = require('../../common/date_range');
const { sha256File } = require('../../common/file-check');
const { validateReportSpec } = require('../../common/md-spec-validator');
const { waitOfficialPageCurrency } = require('../../common/currency-contract');
const { inspectOfficialDownload, validateOfficialValidation } = require('../../validation/validate_shop_promotion_performance');
const { assertExportControlReady, resolveExportControl } = require('../../common/official_ui_control');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function bindInputs(a, b, shop, providerId) {
  if (a?.status !== 'ready' || b?.status !== 'operable' || shop?.status !== 'identified' || shop.provider_id !== providerId) fail('unsupported_provider');
  if (a.shop_alias !== b.requested_shop_alias || a.shop_alias !== shop.shop_alias
    || String(a.browser_id) !== String(b.browser_id) || String(a.browser_id) !== String(shop.browser_id)
    || a.cdp_url !== b.cdp_url || a.cdp_url !== shop.cdp_url) fail('identity_mismatch');
}
function pickerValue(date) { return date.replaceAll('-', '/'); }
function nextDate(date) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); }
function pickerValuesMatch(values, startDate, endDate) { return values[0] === pickerValue(startDate) && values[1] === pickerValue(endDate); }
async function applyDateRange(page, startDate, endDate, rules, businessToday = null) {
  const picker = page.locator(rules.date_picker_selector).first();
  await picker.waitFor({ state: 'visible', timeout: rules.picker_timeout_ms });
  const readValues = () => page.evaluate(({ pickerSelector, inputSelector }) => {
    const root = document.querySelector(pickerSelector);
    if (!root) return [];
    return [...root.querySelectorAll(inputSelector)].slice(0, 2).map((item) => item.value);
  }, { pickerSelector: rules.date_picker_selector, inputSelector: rules.date_input_selector });
  await page.waitForFunction(({ pickerSelector, inputSelector }) => { const root = document.querySelector(pickerSelector); const values = root ? [...root.querySelectorAll(inputSelector)].slice(0, 2).map((item) => item.value) : []; return values.length === 2 && values.every(Boolean); }, { pickerSelector: rules.date_picker_selector, inputSelector: rules.date_input_selector }, { timeout: rules.picker_timeout_ms });
  async function alignMonth(date) {
    const target = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
    for (let attempt = 0; attempt < rules.max_month_moves; attempt += 1) {
      const panels = page.locator(rules.panel_selector); const left = panels.first();
      const labels = await left.locator(rules.header_label_selector).allInnerTexts(); const current = Number(labels[0]) * 12 + Number(labels[1]) - 1;
      if (current === target) return left;
      const panel = current > target ? left : panels.last(); const controls = panel.locator(rules.header_control_selector);
      await (current > target ? controls.last() : controls.first()).click();
    }
    fail('promotion_date_month_unreachable');
  }
  async function selectDate(date, selectedPanel = null) {
    const panel = selectedPanel || await alignMonth(date); const day = String(Number(date.slice(8, 10)));
    const cell = panel.locator(rules.date_cell_selector).filter({ hasText: new RegExp(`^${day}$`) });
    if (await cell.count() !== 1) {
      const disabled = panel.locator(rules.date_cell_disabled_selector).filter({ hasText: new RegExp(`^${day}$`) });
      if (date === businessToday && await disabled.count() === 1) fail('current_date_not_exportable');
      fail('promotion_date_cell_missing');
    }
    await cell.click();
  }
  async function openPicker() {
    const panels = page.locator(rules.panel_visible_selector);
    for (let attempt = 0; attempt < rules.max_picker_attempts; attempt += 1) {
      if (await panels.count() === 2) return;
      const target = attempt === 0 ? picker : picker.locator(rules.suffix_icon_selector);
      await target.click();
      try { await panels.first().waitFor({ state: 'visible', timeout: rules.picker_open_timeout_ms }); } catch {}
    }
    fail('promotion_date_picker_not_open');
  }
  for (let attempt = 0; attempt < rules.max_picker_attempts; attempt += 1) {
    await openPicker();
    const startPanel = await alignMonth(startDate); await selectDate(startDate, startPanel); await selectDate(endDate, startDate.slice(0, 7) === endDate.slice(0, 7) ? startPanel : null);
    await page.waitForFunction(({ start, end, pickerSelector, inputSelector }) => { const root = document.querySelector(pickerSelector); const values = root ? [...root.querySelectorAll(inputSelector)].slice(0, 2).map((item) => item.value) : []; return values[0] === start && values[1] === end; }, { start: pickerValue(startDate), end: pickerValue(endDate), pickerSelector: rules.date_picker_selector, inputSelector: rules.date_input_selector }, { timeout: rules.date_apply_timeout_ms });
    if (pickerValuesMatch(await readValues(), startDate, endDate)) return;
  }
  fail('promotion_date_not_applied');
}
async function exportPromotionPerformance(input, dependencies = {}) {
  const reportSpec = validateReportSpec(input.reportSpec, { skillRoot: dependencies.skillRoot });
  if (input.providerSpec !== reportSpec.providers?.[PROVIDER_ID]) fail('unsupported_provider');
  const rules = validateOfficialValidation({ ...reportSpec, official_validation: input.providerSpec.official_validation });
  if (!/^\d+$/u.test(String(input.shop?.seller_id || ''))) fail('promotion_identity_unavailable');
  bindInputs(input.a, input.b, input.shop, PROVIDER_ID);
  let sellerOrigin; try { sellerOrigin = new URL(input.b.seller_page_url).origin; } catch { fail('provider_binding_invalid'); }
  if (sellerOrigin !== rules.response_origin) fail('provider_binding_invalid');
  const range = resolveDateRange(input, dependencies.now || new Date(), rules.business_timezone);
  const browser = dependencies.browser;
  if (!browser || typeof browser.isConnected !== 'function' || !browser.isConnected()) fail('browser_disconnected');
  const context = dependencies.browserContext;
  if (!context || typeof browser.contexts !== 'function' || !browser.contexts().includes(context)) fail('browser_context_missing');
  const outputDir = path.resolve(input.outputDir); fs.mkdirSync(outputDir, { recursive: true }); if (fs.readdirSync(outputDir).length) fail('output_directory_not_empty');
  const origin = rules.response_origin; const entryUrl = new URL(rules.entry_path, origin); entryUrl.searchParams.set(rules.entry_query.range, `${range.start_date}|${nextDate(range.end_date)}`); entryUrl.searchParams.set(rules.entry_query.shortcut, rules.entry_query.shortcut_value); let page = context.pages().find((item) => { try { return new URL(item.url()).origin === origin; } catch { return false; } }); if (!page) fail('seller_page_missing'); await page.goto(entryUrl.href, { waitUntil: 'domcontentloaded', timeout: rules.navigation_timeout_ms }); await (dependencies.applyDateRange || applyDateRange)(page, range.start_date, range.end_date, rules, range.business_today);
  const currencyEvidence = await waitOfficialPageCurrency(page, reportSpec.currency_contract, rules.date_apply_timeout_ms, dependencies);
    const controlReason = 'shop_promotion_performance_export_control_not_ready';
    const button = await resolveExportControl(page, rules.export_selector, controlReason, rules.download_timeout_ms);
    await assertExportControlReady(button, controlReason); const pending = page.waitForEvent('download', { timeout: rules.download_timeout_ms }); await button.click(); const download = await pending; const downloaded = await download.path(); if (!downloaded) fail('download_missing');
    const staged = path.join(outputDir, 'official_download.xlsx'); try { fs.copyFileSync(downloaded, staged, fs.constants.COPYFILE_EXCL); } catch { fail('download_stage_failed'); }
    const inspected = inspectOfficialDownload({ sourceFile: staged, reportSpec: { ...reportSpec, official_validation: rules } });
    if (inspected.status === 'failed') fail(inspected.reason_code);
  const stat = fs.statSync(staged); return { schema_version: 'shop_promotion_performance_v1', status: inspected.status, provider_id: PROVIDER_ID, shop_alias: input.a.shop_alias, shop_id: String(input.shop.seller_id), advertiser_id: null, start_date: range.start_date, end_date: range.end_date, output_file: staged, byte_length: stat.size, sha256: sha256File(staged), official_file_unchanged: true, data_row_count: inspected.data_row_count, observed_at: new Date().toISOString(), currency_evidence: currencyEvidence };
}
module.exports = { applyDateRange, bindInputs, exportPromotionPerformance, pickerValue, pickerValuesMatch, run: exportPromotionPerformance };
