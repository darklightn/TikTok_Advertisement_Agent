'use strict';

const { json } = require('../../common/shop-api-v3');
const { normalizeCurrencyCode } = require('../../common/currency-contract');

function captureDate(clock = () => new Date()) { return clock().toISOString().slice(0, 10); }
function row(date, campaign, configuration, currency) { return [date, String(campaign.campaign_id), String(campaign.campaign_name), json(configuration), normalizeCurrencyCode(currency)]; }

module.exports = { captureDate, row };
