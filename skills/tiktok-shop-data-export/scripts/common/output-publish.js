'use strict';

const fs = require('fs');
const path = require('path');
const { safeSegment, sha256File } = require('./file-check');
const { validateCsvTable } = require('./csv');
const { renderOutputPath, validatePhysicalOutputPath } = require('./output-path');
const { readFirstWorksheet, readZipEntries } = require('./xlsx_first_sheet');
const { appendXlsxColumns } = require('./xlsx-append-columns');

function failed(reasonCode) {
  return { status: 'failed', reason_code: reasonCode };
}

function singleWorksheet(buffer) {
  const entries = readZipEntries(buffer);
  const workbook = entries.get('xl/workbook.xml');
  if (!workbook) throw Object.assign(new Error('xlsx_workbook_missing'), { code: 'xlsx_workbook_missing' });
  const sheetCount = [...workbook.toString('utf8').matchAll(/<sheet\b[^>]*\/?>/gu)].length;
  if (sheetCount !== 1) throw Object.assign(new Error('xlsx_sheet_count_invalid'), { code: 'xlsx_sheet_count_invalid' });
  return readFirstWorksheet(buffer);
}

function validateStagedXlsx(file, spec) {
  const sheet = singleWorksheet(fs.readFileSync(file));
  const dynamic = spec.dynamic_headers === 'top_level_field_union';
  const validDynamicHeaders = dynamic && sheet.headers.length >= spec.headers.length
    && sheet.headers.every((header) => typeof header === 'string' && header.trim())
    && new Set(sheet.headers).size === sheet.headers.length
    && spec.headers.every((header) => sheet.headers.includes(header));
  if (!validDynamicHeaders && JSON.stringify(sheet.headers) !== JSON.stringify(spec.headers)) {
    throw Object.assign(new Error('xlsx_headers_mismatch'), { code: 'xlsx_headers_mismatch' });
  }
  const keyIndexes = spec.required_key_columns.map((column) => sheet.headers.indexOf(column));
  if (keyIndexes.some((index) => index < 0)) {
    throw Object.assign(new Error('xlsx_required_key_column_missing'), { code: 'xlsx_required_key_column_missing' });
  }
  const dataRowCount = sheet.rows.slice(1).filter((row) => keyIndexes.every((index) => String(row[index] ?? '').trim() !== '')).length;
  return { dataRowCount };
}

function generatedStatus(validation, spec, trustedZero) {
  if (validation.dataRowCount >= 1) {
    if (spec.success_output_type !== 'generated_xlsx') throw Object.assign(new Error('unsupported_output_type'), { code: 'unsupported_output_type' });
    return 'success';
  }
  if (spec.no_data_rule === 'not_applicable') throw Object.assign(new Error('no_data_not_applicable'), { code: 'no_data_not_applicable' });
  if (trustedZero !== true) throw Object.assign(new Error('zero_data_not_trusted'), { code: 'zero_data_not_trusted' });
  if (spec.no_data_output_type !== 'generated_xlsx') throw Object.assign(new Error('unsupported_output_type'), { code: 'unsupported_output_type' });
  return 'no_data';
}

function generatedCsvStatus(validation, spec, trustedZero) {
  if (validation.data_row_count >= 1) {
    if (spec.success_output_type !== 'generated_csv') throw Object.assign(new Error('unsupported_output_type'), { code: 'unsupported_output_type' });
    return 'success';
  }
  if (spec.no_data_rule === 'not_applicable') throw Object.assign(new Error('no_data_not_applicable'), { code: 'no_data_not_applicable' });
  if (trustedZero !== true) throw Object.assign(new Error('zero_data_not_trusted'), { code: 'zero_data_not_trusted' });
  if (spec.no_data_output_type !== 'generated_csv') throw Object.assign(new Error('unsupported_output_type'), { code: 'unsupported_output_type' });
  return 'no_data';
}

function taskSegment(taskId) {
  const text = String(taskId ?? '').normalize('NFKC').trim();
  let cleaned;
  try { cleaned = safeSegment(text); } catch { return null; }
  return cleaned === text ? text : null;
}

function publishGeneratedXlsxInner(options) {
  const { spec, sourceFile, shopRoot, variables, trustedZero = false } = options;
  if (spec?.success_output_type !== 'generated_xlsx' && spec?.no_data_output_type !== 'generated_xlsx') {
    return failed('unsupported_output_type');
  }
  if (!sourceFile || !fs.statSync(sourceFile, { throwIfNoEntry: false })?.isFile()) return failed('source_file_missing');
  const taskId = taskSegment(options.taskId);
  if (!taskId) return failed('task_id_invalid');
  let destination;
  try { destination = renderOutputPath(spec, shopRoot, variables); } catch (error) { return failed(error.code || 'output_path_invalid'); }
  if (path.extname(destination).toLowerCase() !== '.xlsx') return failed('unsupported_output_type');
  try {
    const preflightValidation = validateStagedXlsx(sourceFile, spec);
    if (options.expectedStatus === 'no_data' && preflightValidation.dataRowCount !== 0) return failed('status_row_count_mismatch');
    const preflightStatus = generatedStatus(preflightValidation, spec, trustedZero);
    if (options.expectedStatus && options.expectedStatus !== preflightStatus) return failed('status_row_count_mismatch');
  }
  catch (error) { return failed(error.code || 'xlsx_validation_failed'); }
  try { validatePhysicalOutputPath(destination, shopRoot, { fs: options.physicalFs }); }
  catch (error) { return failed(error.code || 'output_path_invalid'); }
  try { fs.mkdirSync(path.dirname(destination), { recursive: true }); } catch { return failed('output_directory_create_failed'); }
  try { validatePhysicalOutputPath(destination, shopRoot, { fs: options.physicalFs, requireExistingParent: true }); }
  catch (error) { return failed(error.code || 'output_path_invalid'); }
  const base = path.basename(destination, '.xlsx');
  const temporary = path.join(path.dirname(destination), `.${base}.task-${taskId}-${process.pid}.tmp.xlsx`);
  let temporaryCreated = false;
  try {
    try {
      fs.copyFileSync(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
      temporaryCreated = true;
    } catch { return failed('source_copy_failed'); }
    let validation;
    try { validation = validateStagedXlsx(temporary, spec); } catch (error) { return failed(error.code || 'xlsx_validation_failed'); }
    if (options.expectedStatus === 'no_data' && validation.dataRowCount !== 0) return failed('status_row_count_mismatch');
    let status;
    try { status = generatedStatus(validation, spec, trustedZero); } catch (error) { return failed(error.code); }
    if (options.expectedStatus && options.expectedStatus !== status) return failed('status_row_count_mismatch');
    const stagedSha256 = sha256File(temporary);
    const replaceFile = options.replaceFile || ((from, to) => fs.renameSync(from, to));
    try { replaceFile(temporary, destination); } catch { return failed('output_replace_failed'); }
    temporaryCreated = fs.existsSync(temporary);
    let sha256;
    try { sha256 = sha256File(destination); } catch { return failed('published_hash_mismatch'); }
    if (sha256 !== stagedSha256) return failed('published_hash_mismatch');
    return { status, output_file: destination, data_row_count: validation.dataRowCount, sha256 };
  } finally {
    if (temporaryCreated && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function publishGeneratedXlsx(options = {}) {
  try { return publishGeneratedXlsxInner(options); } catch (error) { return failed(error.code || 'output_publish_failed'); }
}

function publishGeneratedCsvInner(options) {
  const { spec, sourceFile, shopRoot, variables, trustedZero = false } = options;
  if (spec?.success_output_type !== 'generated_csv' && spec?.no_data_output_type !== 'generated_csv') return failed('unsupported_output_type');
  if (!sourceFile || !fs.statSync(sourceFile, { throwIfNoEntry: false })?.isFile()) return failed('source_file_missing');
  const taskId = taskSegment(options.taskId); if (!taskId) return failed('task_id_invalid');
  let validation;
  try { validation = validateCsvTable(sourceFile, spec, spec.generated_csv_validation || {}); }
  catch (error) { return failed(error.code || 'csv_validation_failed'); }
  let status;
  try { status = generatedCsvStatus(validation, spec, trustedZero); } catch (error) { return failed(error.code); }
  if (options.expectedStatus && options.expectedStatus !== status) return failed('status_row_count_mismatch');
  let destination;
  try { destination = renderOutputPath(spec, shopRoot, variables); } catch (error) { return failed(error.code || 'output_path_invalid'); }
  if (path.extname(destination).toLowerCase() !== '.csv') return failed('unsupported_output_type');
  try { validatePhysicalOutputPath(destination, shopRoot, { fs: options.physicalFs }); }
  catch (error) { return failed(error.code || 'output_path_invalid'); }
  try { fs.mkdirSync(path.dirname(destination), { recursive: true }); } catch { return failed('output_directory_create_failed'); }
  try { validatePhysicalOutputPath(destination, shopRoot, { fs: options.physicalFs, requireExistingParent: true }); }
  catch (error) { return failed(error.code || 'output_path_invalid'); }
  const base = path.basename(destination, '.csv');
  const temporary = path.join(path.dirname(destination), `.${base}.task-${taskId}-${process.pid}.tmp.csv`);
  let temporaryCreated = false;
  try {
    try { fs.copyFileSync(sourceFile, temporary, fs.constants.COPYFILE_EXCL); temporaryCreated = true; }
    catch { return failed('source_copy_failed'); }
    let checked;
    try { checked = validateCsvTable(temporary, spec, spec.generated_csv_validation || {}); }
    catch (error) { return failed(error.code || 'csv_validation_failed'); }
    let checkedStatus;
    try { checkedStatus = generatedCsvStatus(checked, spec, trustedZero); } catch (error) { return failed(error.code); }
    if (checkedStatus !== status) return failed('status_row_count_mismatch');
    const stagedSha256 = sha256File(temporary);
    try { (options.replaceFile || ((from, to) => fs.renameSync(from, to)))(temporary, destination); }
    catch { return failed('output_replace_failed'); }
    temporaryCreated = fs.existsSync(temporary);
    let publishedSha256;
    try { publishedSha256 = sha256File(destination); } catch { return failed('published_hash_mismatch'); }
    if (publishedSha256 !== stagedSha256) return failed('published_hash_mismatch');
    return { status, output_file: destination, data_row_count: checked.data_row_count, sha256: publishedSha256 };
  } finally { if (temporaryCreated && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function publishGeneratedCsv(options = {}) {
  try { return publishGeneratedCsvInner(options); } catch (error) { return failed(error.code || 'output_publish_failed'); }
}

function publishOfficialDownloadInner(options) {
  const { spec, sourceFile, expectedSha256, status, dataRowCount, noDataEvidence, shopRoot, variables } = options;
  if (!['official_xlsx', 'official_csv'].includes(spec?.success_output_type)) return failed('unsupported_output_type');
  if (!sourceFile || !fs.statSync(sourceFile, { throwIfNoEntry: false })?.isFile()) return failed('source_file_missing');
  const extension = spec.success_output_type === 'official_csv' ? '.csv' : '.xlsx';
  if (path.extname(sourceFile).toLowerCase() !== extension) return failed('unsupported_output_type');
  const taskId = taskSegment(options.taskId);
  if (!taskId) return failed('task_id_invalid');
  if (!/^[a-f0-9]{64}$/u.test(String(expectedSha256 || ''))) return failed('source_hash_mismatch');
  if (!Number.isInteger(dataRowCount) || dataRowCount < 0) return failed('data_row_count_invalid');
  if (status === 'success') {
    if (dataRowCount < 1) return failed('status_row_count_mismatch');
  } else if (status === 'no_data') {
    if (dataRowCount !== 0) return failed('status_row_count_mismatch');
    if (spec.no_data_output_type !== spec.success_output_type) return failed('unsupported_output_type');
    if (!spec.no_data_rule || noDataEvidence !== spec.no_data_rule) return failed('no_data_evidence_mismatch');
  } else return failed('status_invalid');
  let sourceSha256;
  try { sourceSha256 = sha256File(sourceFile); } catch { return failed('source_hash_mismatch'); }
  if (sourceSha256 !== expectedSha256) return failed('source_hash_mismatch');
  let destination;
  if (spec.time_semantics === 'requested_range') {
    const startDate = String(variables?.start_date || '');
    const endDate = String(variables?.end_date || '');
    const validDate = (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(parsed.valueOf())
        && parsed.toISOString().slice(0, 10) === value;
    };
    const expectedTimeFile = spec.single_day_time_file === true && startDate === endDate
      ? `${startDate}${extension}` : `${startDate}_至_${endDate}${extension}`;
    if (!validDate(startDate) || !validDate(endDate)
      || (variables?.time_file !== undefined && !variables.time_file.endsWith(expectedTimeFile))) return failed('output_time_file_invalid');
  }
  try { destination = renderOutputPath(spec, shopRoot, variables); } catch (error) { return failed(error.code || 'output_path_invalid'); }
  if (path.extname(destination).toLowerCase() !== extension) return failed('unsupported_output_type');
  try { validatePhysicalOutputPath(destination, shopRoot, { fs: options.physicalFs }); }
  catch (error) { return failed(error.code || 'output_path_invalid'); }
  try { fs.mkdirSync(path.dirname(destination), { recursive: true }); } catch { return failed('output_directory_create_failed'); }
  try { validatePhysicalOutputPath(destination, shopRoot, { fs: options.physicalFs, requireExistingParent: true }); }
  catch (error) { return failed(error.code || 'output_path_invalid'); }
  const base = path.basename(destination, extension);
  const temporary = path.join(path.dirname(destination), `.${base}.task-${taskId}-${process.pid}.tmp${extension}`);
  let temporaryCreated = false;
  try {
    try {
      fs.copyFileSync(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
      temporaryCreated = true;
    } catch { return failed('source_copy_failed'); }
    let temporarySha256;
    try { temporarySha256 = sha256File(temporary); } catch { return failed('temporary_hash_mismatch'); }
    if (temporarySha256 !== expectedSha256) return failed('temporary_hash_mismatch');
    if (options.xlsxColumns !== undefined) {
      if (extension !== '.xlsx' || status !== 'success') return failed('xlsx_append_column_invalid');
      try { fs.writeFileSync(temporary, appendXlsxColumns(fs.readFileSync(temporary), options.xlsxColumns)); }
      catch (error) { return failed(error.code || 'xlsx_append_column_failed'); }
    }
    let stagedSha256;
    try { stagedSha256 = sha256File(temporary); } catch { return failed('temporary_hash_mismatch'); }
    const replaceFile = options.replaceFile || ((from, to) => fs.renameSync(from, to));
    try { replaceFile(temporary, destination); } catch { return failed('output_replace_failed'); }
    temporaryCreated = fs.existsSync(temporary);
    let publishedSha256;
    try { publishedSha256 = sha256File(destination); } catch { return failed('published_hash_mismatch'); }
    if (publishedSha256 !== stagedSha256) return failed('published_hash_mismatch');
    return { status, output_file: destination, data_row_count: dataRowCount, sha256: publishedSha256 };
  } finally {
    if (temporaryCreated && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function publishOfficialDownload(options = {}) {
  try { return publishOfficialDownloadInner(options); } catch (error) { return failed(error.code || 'output_publish_failed'); }
}

module.exports = { publishGeneratedCsv, publishGeneratedXlsx, publishOfficialDownload, validateStagedXlsx };
