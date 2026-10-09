'use strict';

const { json, without } = require('../../common/shop-api-v3');
const { normalizeCurrencyCode } = require('../../common/currency-contract');

function productRow(tab, productId, product, contract, currency) { return [String(tab.tab_id), tab.status, productId, json(without(product, [contract.sku_list_path[0]])), normalizeCurrencyCode(currency)]; }
function skuRow(tab, productId, skuId, sku, currency) { return [String(tab.tab_id), tab.status, productId, skuId, json(sku), normalizeCurrencyCode(currency)]; }

module.exports = { productRow, skuRow };
