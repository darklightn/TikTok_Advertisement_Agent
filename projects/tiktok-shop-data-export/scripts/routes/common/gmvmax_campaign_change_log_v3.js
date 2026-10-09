'use strict';
const { json } = require('../../common/shop-api-v3');
const { normalizeCurrencyCode } = require('../../common/currency-contract');
function row(campaignId,item,idField,currency){return[String(campaignId),String(item[idField]),json(item),normalizeCurrencyCode(currency)];}
module.exports={row};
