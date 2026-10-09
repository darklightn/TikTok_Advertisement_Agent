'use strict';

const { json } = require('../../common/shop-api-v3');
const { normalizeCurrencyCode } = require('../../common/currency-contract');

function captureDate(clock = () => new Date()) { return clock().toISOString().slice(0, 10); }
function row(date, advertiserId, advertiserName, snapshot, currency) { return [date, String(advertiserId), String(advertiserName), json(snapshot), normalizeCurrencyCode(currency)]; }

module.exports = { captureDate, row };
