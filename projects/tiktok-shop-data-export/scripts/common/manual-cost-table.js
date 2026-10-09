'use strict';

const fs = require('fs');
const path = require('path');
const { writeWorkbook } = require('./xlsx_writer');

const MANUAL_COST_HEADERS = Object.freeze([
  'SKU ID',
  '商品名称',
  'SKU名称/规格',
  '生效日期',
  '币种',
  '单位采购成本',
  '单位头程成本',
  '单位关税及清关成本',
  '单位包装成本',
  '平台费率（%）',
  '单位本地物流成本',
  '单位仓租分摊',
  '备注',
]);

const MANUAL_COST_DIRECTORY = '15_人工录入';
const MANUAL_COST_FILENAME = '成本表.xlsx';

function manualCostTablePath(shopRoot) {
  if (typeof shopRoot !== 'string' || !path.isAbsolute(shopRoot)) {
    throw Object.assign(new Error('manual_cost_table_root_invalid'), { code: 'manual_cost_table_root_invalid' });
  }
  return path.join(shopRoot, MANUAL_COST_DIRECTORY, MANUAL_COST_FILENAME);
}

function ensureManualCostTable(shopRoot) {
  const file = manualCostTablePath(shopRoot);
  if (fs.existsSync(file)) return { status: 'exists', file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeWorkbook(file, [MANUAL_COST_HEADERS], { sheetName: '成本表', flag: 'wx' });
    return { status: 'created', file };
  } catch (error) {
    if (error?.code === 'EEXIST') return { status: 'exists', file };
    throw error;
  }
}

module.exports = {
  MANUAL_COST_DIRECTORY,
  MANUAL_COST_FILENAME,
  MANUAL_COST_HEADERS,
  ensureManualCostTable,
  manualCostTablePath,
};
