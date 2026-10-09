'use strict';

const fs = require('fs');
const { sha256File } = require('../common/file-check');
const { countXlsxDataRows } = require('../common/official_download_rows');

const REPORT_ID = 'shop_promotion_performance';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function validateOfficialValidation(reportSpec) {
  if (reportSpec?.report_id !== REPORT_ID) fail('promotion_report_spec_mismatch');
  const rules = reportSpec.official_validation;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) fail('promotion_official_validation_invalid');
  const entryQuery = rules.entry_query;
  let responseOrigin; try { responseOrigin = new URL(rules.response_origin); } catch { fail('promotion_official_validation_invalid'); }
  const dateApplication = rules.date_application;
  try { if (new Intl.DateTimeFormat('en-US', { timeZone:rules.business_timezone }).resolvedOptions().timeZone !== rules.business_timezone) fail('promotion_official_validation_invalid'); }
  catch { fail('promotion_official_validation_invalid'); }
  if (responseOrigin.origin !== rules.response_origin || typeof rules.entry_path !== 'string' || !rules.entry_path.startsWith('/')
    || !entryQuery || typeof entryQuery !== 'object' || Array.isArray(entryQuery)
    || !['range', 'shortcut', 'shortcut_value'].every((key) => typeof entryQuery[key] === 'string' && entryQuery[key])
    || entryQuery.end_semantics !== 'exclusive_next_day'
    || !['picker', 'local_picker'].includes(dateApplication)
    || !['date_picker_selector', 'date_cell_disabled_selector', 'export_selector'].every((key) => typeof rules[key] === 'string' && rules[key])
    || !['navigation_timeout_ms', 'picker_timeout_ms', 'download_timeout_ms']
      .every((key) => Number.isInteger(rules[key]) && rules[key] > 0)
    || !Number.isInteger(rules.data_start_row) || rules.data_start_row < 1) {
    fail('promotion_official_validation_invalid');
  }
  if (dateApplication === 'picker') {
    let dateResponseOrigin;
    try { dateResponseOrigin = new URL(rules.date_response_origin); } catch { fail('promotion_official_validation_invalid'); }
    if (dateResponseOrigin.origin !== rules.date_response_origin
      || !['date_input_selector', 'panel_selector', 'panel_visible_selector', 'header_label_selector', 'header_control_selector',
      'date_cell_selector', 'suffix_icon_selector'].every((key) => typeof rules[key] === 'string' && rules[key])
      || typeof rules.date_refresh_path !== 'string' || !rules.date_refresh_path.startsWith('/')
      || !['picker_open_timeout_ms', 'date_apply_timeout_ms', 'max_month_moves', 'max_picker_attempts']
        .every((key) => Number.isInteger(rules[key]) && rules[key] > 0)) {
      fail('promotion_official_validation_invalid');
    }
  }
  if (dateApplication === 'local_picker'
    && (!['date_picker_disabled_class', 'date_picker_input_selector', 'panel_visible_selector', 'header_label_selector', 'header_control_selector', 'date_cell_selector']
      .every((key) => typeof rules[key] === 'string' && rules[key])
      || !['picker_open_timeout_ms', 'date_apply_timeout_ms', 'max_month_moves']
        .every((key) => Number.isInteger(rules[key]) && rules[key] > 0))) {
    fail('promotion_official_validation_invalid');
  }
  return rules;
}

function inspectOfficialDownload({ sourceFile, reportSpec }) {
  try {
    const rules = validateOfficialValidation(reportSpec);
    if (!sourceFile || !fs.statSync(sourceFile, { throwIfNoEntry: false })?.isFile()) fail('source_file_missing');
    const buffer = fs.readFileSync(sourceFile);
    return { status: 'success', data_row_count: countXlsxDataRows(buffer, rules.data_start_row) };
  } catch (error) {
    return { status: 'failed', reason_code: error.code || 'promotion_official_file_invalid' };
  }
}

function validate(value, reportSpec) {
  const errors = [];
  const inspected = inspectOfficialDownload({
    sourceFile: value?.output_file,
    reportSpec,
  });
  if (inspected.status === 'failed') errors.push(inspected.reason_code);
  else {
    if (!['success', 'no_data'].includes(value?.status) || value.status !== inspected.status) errors.push('status_mismatch');
    if (value?.data_row_count !== inspected.data_row_count) errors.push('data_row_count_mismatch');
    if (value?.official_file_unchanged !== true) errors.push('official_file_changed');
    if (value?.byte_length !== fs.statSync(value.output_file).size) errors.push('byte_length_mismatch');
    if (value?.sha256 !== sha256File(value.output_file)) errors.push('sha256_mismatch');
  }
  return { status: errors.length ? 'failed' : 'passed', errors, data_row_count: inspected.data_row_count ?? null };
}

module.exports = { inspectOfficialDownload, validate, validateOfficialValidation };
