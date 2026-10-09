'use strict';

const crypto = require('crypto');
const { countXlsxDataRows } = require('../../common/official_download_rows');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function inspectOfficial(buffer, providerSpec) {
  return countXlsxDataRows(buffer, providerSpec.official_validation.data_start_row);
}

module.exports = { inspectOfficial, sha256 };
