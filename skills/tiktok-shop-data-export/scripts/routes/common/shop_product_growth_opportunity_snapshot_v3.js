'use strict';

const { getPath, json } = require('../../common/shop-api-v3');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function parsePage(body, contract) {
  const products=getPath(body,contract.record_path);const total=getPath(body,contract.total_path);
  if(!Array.isArray(products)||!Number.isInteger(total)||total<0)fail('shop_product_growth_shape_mismatch');
  return{products,total};
}
function rows(products, contract) { return products.map((product)=>[String(getPath(product,contract.record_key_path)),json(product)]); }

module.exports={parsePage,rows};
