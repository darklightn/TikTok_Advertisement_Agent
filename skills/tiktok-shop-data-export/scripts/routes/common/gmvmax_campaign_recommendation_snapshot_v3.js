'use strict';

const { json } = require('../../common/shop-api-v3');
const { normalizeCurrencyCode } = require('../../common/currency-contract');

function captureDate(clock = () => new Date()) { return clock().toISOString().slice(0, 10); }
function itemsRow(campaignId, items, currency) { return [String(campaignId), json(items), normalizeCurrencyCode(currency)]; }
function summaryRow(campaignId, summary, currency) { return [String(campaignId), json(summary), normalizeCurrencyCode(currency)]; }

module.exports = { captureDate, itemsRow, summaryRow };
