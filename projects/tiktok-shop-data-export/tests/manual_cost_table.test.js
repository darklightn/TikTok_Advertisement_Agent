'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MANUAL_COST_HEADERS,
  ensureManualCostTable,
  manualCostTablePath,
} = require('../scripts/common/manual-cost-table');
const { readFirstWorksheet, readZipEntries } = require('../scripts/common/xlsx_first_sheet');

function temporaryShopRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-cost-table-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '测试店__88001');
}

test('creates the exact header-only cost workbook once', (t) => {
  const shopRoot = temporaryShopRoot(t);
  const result = ensureManualCostTable(shopRoot);
  const buffer = fs.readFileSync(result.file);
  const worksheet = readFirstWorksheet(buffer);
  const workbookXml = readZipEntries(buffer).get('xl/workbook.xml').toString('utf8');

  assert.deepEqual(result, { status: 'created', file: manualCostTablePath(shopRoot) });
  assert.deepEqual(worksheet.rows, [MANUAL_COST_HEADERS]);
  assert.equal(worksheet.row_count, 1);
  assert.equal(worksheet.column_count, 13);
  assert.match(workbookXml, /<sheet name="成本表" sheetId="1"/u);
});

test('an existing cost file is never read or overwritten', (t) => {
  const shopRoot = temporaryShopRoot(t);
  const file = manualCostTablePath(shopRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = Buffer.from('arbitrary existing user bytes');
  fs.writeFileSync(file, existing);

  assert.deepEqual(ensureManualCostTable(shopRoot), { status: 'exists', file });
  assert.deepEqual(fs.readFileSync(file), existing);
});

test('an exclusive-create EEXIST race is treated as already existing', (t) => {
  const shopRoot = temporaryShopRoot(t);
  const file = manualCostTablePath(shopRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const winner = Buffer.from('created by concurrent winner');
  fs.writeFileSync(file, winner);
  const existsSync = fs.existsSync;
  fs.existsSync = () => false;
  t.after(() => { fs.existsSync = existsSync; });

  assert.deepEqual(ensureManualCostTable(shopRoot), { status: 'exists', file });
  assert.deepEqual(fs.readFileSync(file), winner);
});
