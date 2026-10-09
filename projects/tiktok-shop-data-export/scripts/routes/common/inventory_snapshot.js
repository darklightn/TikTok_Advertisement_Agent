'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeWorkbook } = require('../../common/xlsx_writer');

function fail(code) { throw Object.assign(new Error(code), { code }); }
// Transitional compatibility export for three unmigrated common runners; inventory v2 runners do not use it.
function sellerOrigin(url) { const parsed = new URL(url); if (!/^seller(?:-[a-z]{2})?\.tiktok\.com$/i.test(parsed.hostname) && !['seller.tiktokglobalshop.com', 'seller.tiktokshopglobalselling.com'].includes(parsed.hostname)) fail('seller_origin_invalid'); return parsed.origin; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : ''; }
function field(value, key, rules) { return value?.[rules.response_fields[key]]; }
function statusLabel(sku, rules) { if (Number(field(sku, 'open_quantity', rules)) <= 0) return '缺货'; if (String(field(sku, 'stock_days_left', rules) || '').startsWith('<') || Number(field(sku, 'replenishment_quantity', rules)) > 0) return '需关注'; return '库存充足'; }
function validStockListBody(body, rules) { const total = field(body, 'total', rules); return Number.isInteger(total) && total >= 0 && Array.isArray(field(body, 'records', rules)); }
function rowsFor(headers, skus, capturedAt, rules) {
  if (!Array.isArray(headers) || !headers.length) fail('inventory_report_headers_missing');
  const fields = rules.response_fields;
  return [headers.slice(), ...skus.map((sku) => [capturedAt, String(field(sku, 'product_id', rules) || ''), String(field(sku, 'sku_id', rules) || ''), field(sku, 'product_title', rules) || '', field(sku, 'seller_sku', rules) || '', (field(sku, 'properties', rules) || []).map((item) => `${item[fields.property_name]}: ${item[fields.property_value]}`).join('; '), field(sku, 'status', rules) ?? '', statusLabel(sku, rules), number(field(sku, 'warehouse_total', rules)), number(field(sku, 'open_quantity', rules)), number(field(sku, 'withholding', rules)), number(field(sku, 'sales', rules)), number(field(sku, 'forecast_sales', rules)), number(field(sku, 'replenishment_quantity', rules)), field(sku, 'stock_days_left', rules) || '', (field(sku, 'warehouse_list', rules) || []).map((item) => item[fields.warehouse_name]).filter(Boolean).join('; ')])];
}
function writeInventoryWorkbook(input, skus, capturedAt, rules) {
  fs.mkdirSync(input.outputDir, { recursive: true });
  const stamp = capturedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const outputFile = path.join(input.outputDir, `库存诊断快照_${stamp}.xlsx`);
  writeWorkbook(outputFile, rowsFor(input.reportSpec.headers, skus, capturedAt, rules), { sheetName: rules.sheet_name });
  const buffer = fs.readFileSync(outputFile);
  return {
    schema_version: 'inventory_snapshot_v1', status: skus.length ? 'success' : 'no_data',
    shop_alias: input.a.shop_alias, shop_id: String(input.shop.seller_id), captured_at: capturedAt,
    date_semantics: 'snapshot', row_count: skus.length, output_file: outputFile,
    generated_filename: path.basename(outputFile), generated_file: true,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), byte_length: buffer.length,
  };
}

module.exports = { field, rowsFor, sellerOrigin, statusLabel, validStockListBody, writeInventoryWorkbook };
