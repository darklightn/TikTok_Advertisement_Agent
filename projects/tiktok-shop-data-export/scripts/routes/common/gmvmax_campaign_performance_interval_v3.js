'use strict';

const { json } = require('../../common/shop-api-v3');
const { normalizeCurrencyCode } = require('../../common/currency-contract');

function headers(campaigns) {
  const values = []; const seen = new Set();
  for (const campaign of campaigns) {
    for (const key of Object.keys(campaign)) {
      if (!seen.has(key)) { seen.add(key); values.push(key); }
    }
  }
  if (!seen.has('currency')) values.push('currency');
  return values;
}

function cell(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? json(value) : value;
}

function row(campaign, columns, currency) {
  return columns.map((column) => column === 'currency' && !(column in campaign)
    ? normalizeCurrencyCode(currency)
    : cell(campaign[column]));
}

module.exports = { headers, row };
