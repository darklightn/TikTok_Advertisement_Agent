'use strict';

const crypto = require('crypto');
const { countXlsxDataRows } = require('../../common/official_download_rows');

function validDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))
    && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function inspectWorkbook(buffer, spec, rules) { return countXlsxDataRows(buffer, rules.data_start_row); }

module.exports = { inspectWorkbook, sha256, validDate };
