'use strict';

const fs = require('fs');

function fail(code) { throw Object.assign(new Error(code), { code }); }

function decodeUtf8(buffer, bom = 'optional') {
  if (!Buffer.isBuffer(buffer)) fail('csv_buffer_invalid');
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  if ((bom === 'required' && !hasBom) || (bom === 'forbidden' && hasBom)
    || !['required', 'optional', 'forbidden'].includes(bom)) fail('csv_bom_invalid');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? buffer.subarray(3) : buffer); }
  catch { fail('csv_encoding_invalid'); }
}

function parseCsv(buffer, options = {}) {
  if ((options.delimiter || ',') !== ',') fail('csv_delimiter_invalid');
  const text = decodeUtf8(buffer, options.bom || 'optional');
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const value = text[index];
    if (quoted) {
      if (value === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (value === '"') quoted = false;
      else cell += value;
    } else if (value === '"') quoted = true;
    else if (value === ',') { row.push(cell); cell = ''; }
    else if (value === '\n') { row.push(cell.replace(/\r$/u, '')); rows.push(row); row = []; cell = ''; }
    else cell += value;
  }
  if (quoted) fail('csv_malformed');
  if (cell || row.length) { row.push(cell.replace(/\r$/u, '')); rows.push(row); }
  if (!rows.length) fail('csv_empty');
  const width = rows[0].length;
  if (rows.some((item) => item.length !== width)) fail('csv_row_width_mismatch');
  return { rows, has_bom: buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf, delimiter: ',' };
}

function encodeCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length) fail('csv_rows_invalid');
  const width = rows[0].length;
  if (rows.some((row) => !Array.isArray(row) || row.length !== width)) fail('csv_rows_invalid');
  const text = `${rows.map((row) => row.map(encodeCell).join(',')).join('\r\n')}\r\n`;
  fs.writeFileSync(file, `${options.bom === false ? '' : '\uFEFF'}${text}`, { encoding: 'utf8', flag: 'wx' });
}

function validateCsvTable(file, spec, options = {}) {
  const parsed = parseCsv(fs.readFileSync(file), options);
  const headers = parsed.rows[0];
  if (JSON.stringify(headers) !== JSON.stringify(spec.headers)) fail('csv_headers_mismatch');
  const indexes = spec.required_key_columns.map((column) => headers.indexOf(column));
  if (indexes.some((index) => index < 0)) fail('csv_required_key_column_missing');
  const dataRows = parsed.rows.slice(1);
  const validRows = dataRows.filter((row) => indexes.every((index) => String(row[index] ?? '').trim()));
  return { ...parsed, data_rows: dataRows, data_row_count: validRows.length };
}

module.exports = { parseCsv, validateCsvTable, writeCsv };
