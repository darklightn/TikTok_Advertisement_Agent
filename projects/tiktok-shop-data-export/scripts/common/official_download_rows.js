'use strict';

const { readFirstWorksheet } = require('./xlsx_first_sheet');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function nonempty(value) { return String(value ?? '').trim() !== ''; }

function countXlsxDataRows(buffer, dataStartRow) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    fail('official_workbook_invalid');
  }
  if (!Number.isInteger(dataStartRow) || dataStartRow < 1) fail('official_data_start_invalid');
  let sheet;
  try { sheet = readFirstWorksheet(buffer); } catch { fail('official_workbook_invalid'); }
  const count = sheet.rows.slice(dataStartRow - 1).filter((row) => row.some(nonempty)).length;
  if (count < 1) fail('official_data_row_count_mismatch');
  return count;
}

function countCsvDataRows(buffer, dataStartRow) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('official_file_empty');
  if (!Number.isInteger(dataStartRow) || dataStartRow < 1) fail('official_data_start_invalid');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/u, ''); }
  catch { fail('official_csv_invalid'); }
  if (text.includes('\u0000')) fail('official_csv_invalid');
  const prefix = text.trimStart().slice(0, 1024);
  if (prefix.startsWith('<') || /^(?:please\s+)?(?:log\s*in|login)\b/iu.test(prefix)) {
    fail('transport_login_required');
  }
  const records = [];
  let record = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      record += character;
      if (quoted && text[index + 1] === '"') {
        record += text[index + 1];
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (character === '\r' || character === '\n')) {
      records.push(record);
      record = '';
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      record += character;
    }
  }
  if (quoted) fail('official_csv_invalid');
  if (record !== '') records.push(record);
  const meaningful = (value) => value.replace(/[\s,;|"']/gu, '') !== '';
  const count = records.slice(dataStartRow - 1).filter(meaningful).length;
  if (count < 1) fail('official_data_row_count_mismatch');
  return count;
}

module.exports = { countCsvDataRows, countXlsxDataRows };
