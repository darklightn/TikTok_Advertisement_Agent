'use strict';

const { readFirstWorksheet, readZipEntries } = require('./xlsx_first_sheet');
const { zip } = require('./xlsx_writer');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function xml(value) {
  return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}
function columnName(index) {
  let value = index + 1; let name = '';
  while (value > 0) { value -= 1; name = String.fromCharCode(65 + (value % 26)) + name; value = Math.floor(value / 26); }
  return name;
}
function extendReference(source, column, lastRow) {
  const start = source.includes(':') ? source.split(':')[0] : 'A1';
  return `${start}:${column}${lastRow}`;
}

function appendXlsxColumn(buffer, header, value) {
  if (!Buffer.isBuffer(buffer) || typeof header !== 'string' || !header.trim() || value === undefined || value === null) {
    fail('xlsx_append_column_invalid');
  }
  const expected = String(value); const parsed = readFirstWorksheet(buffer);
  const existing = parsed.headers.indexOf(header);
  if (existing >= 0) {
    const rows = parsed.rows.slice(1).filter((row) => row.some((cell) => String(cell ?? '').trim()));
    if (rows.every((row) => String(row[existing] ?? '') === expected)) return buffer;
    fail('xlsx_append_column_conflict');
  }
  if (!parsed.rows.length) fail('xlsx_append_column_invalid');
  const entries = readZipEntries(buffer); const sheet = entries.get(parsed.sheet_path)?.toString('utf8');
  if (!sheet) fail('xlsx_append_column_invalid');
  const column = columnName(parsed.column_count); let appended = 0;
  let updated = sheet.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>/gu, (match, attributes, body) => {
    const rowMatch = attributes.match(/(?:^|\s)r="(\d+)"/u);
    if (!rowMatch) return match;
    const row = Number(rowMatch[1]); const cellValue = row === 1 ? header : expected;
    appended += 1;
    return `<row${attributes}>${body}<c r="${column}${row}" t="inlineStr"><is><t xml:space="preserve">${xml(cellValue)}</t></is></c></row>`;
  });
  if (!appended) fail('xlsx_append_column_invalid');
  updated = updated.replace(/(<dimension\b[^>]*\bref=")([^"]+)(")/u,
    (_match, prefix, reference, suffix) => `${prefix}${extendReference(reference, column, parsed.row_count)}${suffix}`);
  updated = updated.replace(/(<autoFilter\b[^>]*\bref=")([^"]+)(")/u,
    (_match, prefix, reference, suffix) => `${prefix}${extendReference(reference, column, parsed.row_count)}${suffix}`);
  entries.set(parsed.sheet_path, Buffer.from(updated));
  const output = zip([...entries.entries()]); const verified = readFirstWorksheet(output);
  const index = verified.headers.indexOf(header);
  if (index < 0 || verified.rows.slice(1).filter((row) => row.some((cell) => String(cell ?? '').trim()))
    .some((row) => String(row[index] ?? '') !== expected)) fail('xlsx_append_column_verify_failed');
  return output;
}

function appendXlsxColumns(buffer, columns) {
  if (!columns || typeof columns !== 'object' || Array.isArray(columns) || !Object.keys(columns).length) {
    fail('xlsx_append_column_invalid');
  }
  return Object.entries(columns).reduce((current, [header, value]) => appendXlsxColumn(current, header, value), buffer);
}

module.exports = { appendXlsxColumns };
