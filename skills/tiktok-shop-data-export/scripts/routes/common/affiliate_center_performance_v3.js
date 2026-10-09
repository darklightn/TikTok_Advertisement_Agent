'use strict';

const crypto = require('crypto');
const { countXlsxDataRows } = require('../../common/official_download_rows');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function displayedRange(start, end) { const display = (value) => `${Number(value.slice(0, 4))}/${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`; return `${display(start)} - ${display(end)}`; }
function inspectWorkbook(buffer, spec, providerSpec = spec.providers?.cross_border) {
  return countXlsxDataRows(buffer, providerSpec.official_validation.data_start_row);
}

module.exports = { displayedRange, inspectWorkbook, sha256 };
