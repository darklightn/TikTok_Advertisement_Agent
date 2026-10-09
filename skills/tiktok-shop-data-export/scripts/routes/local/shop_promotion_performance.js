'use strict';
const PROVIDER_ID = 'local';
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
function normalizedPickerDate(value) {
  const match = String(value || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/u);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
}
function selectLatestSellerPage(context, origin) {
  return context.pages().filter((item) => { try { return new URL(item.url()).origin === origin; } catch { return false; } }).at(-1) || null;
}
async function applyDateRange(page, startDate, endDate, rules, dependencies = {}, businessToday = null) {
  const picker = page.locator(rules.date_picker_selector).first();
  await picker.waitFor({ state: 'visible', timeout: rules.picker_timeout_ms });
  const now = dependencies.nowMs || Date.now;
  const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const readyDeadline = now() + rules.picker_timeout_ms;
  for (;;) {
    const pickerClass = String(await picker.getAttribute('class') || '');
    const inputs = picker.locator(rules.date_picker_input_selector);
    const inputCount = await inputs.count();
    let inputsReady = inputCount === 2;
    for (let index = 0; inputsReady && index < inputCount; index += 1) inputsReady = await inputs.nth(index).isEnabled();
    if (!pickerClass.split(/\s+/u).includes(rules.date_picker_disabled_class) && inputsReady) break;
    if (now() >= readyDeadline) fail('promotion_date_picker_not_ready');
    await delay(Math.min(50, Math.max(0, readyDeadline - now())));
  }
  await picker.click();
  const panels = page.locator(rules.panel_visible_selector);
  await panels.first().waitFor({ state: 'visible', timeout: rules.picker_open_timeout_ms })
    .catch(() => fail('promotion_date_picker_not_open'));
  if (await panels.count() !== 2) fail('promotion_date_picker_not_open');
  async function panelForMonth(date) {
    const target = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
    for (let move = 0; move < rules.max_month_moves; move += 1) {
      const visible = [panels.first(), panels.last()]; const months = [];
      for (const panel of visible) {
        const labels = await panel.locator(rules.header_label_selector).allInnerTexts();
        const month = Number(labels[0]) * 12 + Number(labels[1]) - 1; months.push(month);
        if (month === target) return panel;
      }
      const panel = target < months[0] ? visible[0] : visible[1];
      const controls = panel.locator(rules.header_control_selector);
      await (target < months[0] ? controls.last() : controls.first()).click();
    }
    fail('promotion_date_month_unreachable');
  }
  async function selectDate(date) {
    const panel = await panelForMonth(date); const day = String(Number(date.slice(8, 10)));
    const cell = panel.locator(rules.date_cell_selector).filter({ hasText: new RegExp(`^${day}$`) });
    if (await cell.count() !== 1) {
      const disabled = panel.locator(rules.date_cell_disabled_selector).filter({ hasText: new RegExp(`^${day}$`) });
      if (date === businessToday && await disabled.count() === 1) fail('current_date_not_exportable');
      fail('promotion_date_cell_missing');
    }
    await cell.click();
  }
  await selectDate(startDate); await selectDate(endDate);
  await panels.first().waitFor({ state: 'hidden', timeout: rules.date_apply_timeout_ms })
    .catch(() => fail('promotion_date_not_applied'));
  const selectedInputs = picker.locator(rules.date_picker_input_selector);
  const appliedDeadline = now() + rules.date_apply_timeout_ms;
  for (;;) {
    if (await selectedInputs.count() === 2) {
      const selectedStart = normalizedPickerDate(await selectedInputs.nth(0).inputValue());
      const selectedEnd = normalizedPickerDate(await selectedInputs.nth(1).inputValue());
      if (selectedStart === startDate && selectedEnd === endDate) break;
    }
    if (now() >= appliedDeadline) fail('promotion_date_not_applied');
    await delay(Math.min(50, Math.max(0, appliedDeadline - now())));
  }
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
  const origin = rules.response_origin; const entryUrl = new URL(rules.entry_path, origin); const page = selectLatestSellerPage(context, origin); if (!page) fail('seller_page_missing');
  let currentPath; try { currentPath = new URL(page.url()).pathname; } catch { currentPath = ''; }
  if (currentPath !== rules.entry_path) await page.goto(entryUrl.href, { waitUntil: 'domcontentloaded', timeout: rules.navigation_timeout_ms });
  await (dependencies.applyDateRange || applyDateRange)(page, range.start_date, range.end_date, rules, dependencies, range.business_today);
  const currencyEvidence = await waitOfficialPageCurrency(page, reportSpec.currency_contract, rules.date_apply_timeout_ms, dependencies);
    const controlReason = 'shop_promotion_performance_export_control_not_ready';
    const button = await resolveExportControl(page, rules.export_selector, controlReason, rules.download_timeout_ms);
    await button.scrollIntoViewIfNeeded(); await assertExportControlReady(button, controlReason); const pending = page.waitForEvent('download', { timeout: rules.download_timeout_ms }); await button.click(); const download = await pending; const downloaded = await download.path(); if (!downloaded) fail('download_missing');
    const staged = path.join(outputDir, 'official_download.xlsx'); try { fs.copyFileSync(downloaded, staged, fs.constants.COPYFILE_EXCL); } catch { fail('download_stage_failed'); }
    const inspected = inspectOfficialDownload({ sourceFile: staged, reportSpec: { ...reportSpec, official_validation: rules } });
    if (inspected.status === 'failed') fail(inspected.reason_code);
  const stat = fs.statSync(staged); return { schema_version: 'shop_promotion_performance_v1', status: inspected.status, provider_id: PROVIDER_ID, shop_alias: input.a.shop_alias, shop_id: String(input.shop.seller_id), advertiser_id: null, start_date: range.start_date, end_date: range.end_date, output_file: staged, byte_length: stat.size, sha256: sha256File(staged), official_file_unchanged: true, data_row_count: inspected.data_row_count, observed_at: new Date().toISOString(), currency_evidence: currencyEvidence };
}
module.exports = { applyDateRange, bindInputs, exportPromotionPerformance, normalizedPickerDate, selectLatestSellerPage, run: exportPromotionPerformance };
