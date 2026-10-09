'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { parseCsv } = require('../scripts/common/csv');
const { embedCurrency } = require('../scripts/common/currency-embed');
const {
  captureOfficialPageCurrency,
  captureProductListCurrency,
  currencyEvidenceFromApi,
  currencyEvidenceFromText,
  validateCurrencyContract,
  validateCurrencyEvidence,
} = require('../scripts/common/currency-contract');
const { row: changeLogRow } = require('../scripts/routes/common/gmvmax_campaign_change_log_v3');
const { itemsRow, summaryRow } = require('../scripts/routes/common/gmvmax_campaign_recommendation_snapshot_v3');

function currencyContract() {
  return {
    schema_version: 'currency_contract_v1',
    source_kind: 'official_report_page_symbol',
    output_kind: 'embedded_table_metadata',
    amount_scope: 'all_monetary_fields',
    currency_symbol: '₱',
    currency_code: 'PHP',
  };
}

function productListContract() {
  return {
    ...currencyContract(), source_kind:'product_list_api_currency_code',
    api_items_path:['data','items'], api_metric_container_path:['stats_v3','total'],
    api_currency_field:'currency_code', api_amount_sibling_fields:['amount','amount_delimited','amount_formatted'],
  };
}

function evidence() {
  return {
    currency_code: 'PHP',
    currency_symbol: '₱',
    currency_source: 'official_report_page_symbol',
    amount_scope: 'all_monetary_fields',
  };
}

test('official report-page peso evidence maps only to PHP', async () => {
  const contract = currencyContract();
  assert.deepEqual(currencyEvidenceFromText('GMV ₱100.00', contract), evidence());
  assert.throws(() => currencyEvidenceFromText('GMV 100.00', contract), { code:'currency_evidence_missing' });
  assert.throws(() => currencyEvidenceFromText('GMV $100.00', contract), { code:'currency_evidence_missing' });
  assert.throws(() => validateCurrencyContract({ ...contract, currency_code:'USD' }), { code:'currency_contract_invalid' });
  assert.throws(() => validateCurrencyContract({ ...contract, currency_code:'php' }), { code:'currency_contract_invalid' });
  assert.throws(() => validateCurrencyEvidence({ ...evidence(), currency_code:'USD' }, contract), { code:'currency_evidence_invalid' });
  const page = { locator:(selector) => { assert.equal(selector, 'body'); return { innerText:async () => 'Current report ₱100' }; } };
  assert.deepEqual(await captureOfficialPageCurrency(page, contract), evidence());
});

test('official page currency reads the body locator instead of calling Page.innerText without a selector', async () => {
  let directCalls = 0;
  let bodyCalls = 0;
  const page = {
    url: () => 'https://seller.example/report',
    innerText: async () => {
      directCalls += 1;
      throw new Error('selector required');
    },
    locator: (selector) => {
      assert.equal(selector, 'body');
      return {
        innerText: async () => {
          bodyCalls += 1;
          return 'GMV ₱100.00';
        },
      };
    },
  };
  const evidence = await captureOfficialPageCurrency(page, currencyContract());
  assert.equal(evidence.currency_code, 'PHP');
  assert.equal(directCalls, 0);
  assert.equal(bodyCalls, 1);
});

test('product list API currency requires consistent ISO codes on monetary objects', async () => {
  const contract = productListContract();
  const body = { data:{ items:[{ stats_v3:{ total:{ gmv:{ amount:'10', currency_code:'PHP' },
    cost:{ amount_formatted:'₱20', currency_code:'php' }, ratio:{ value:'1', currency_code:'USD' } } } }] } };
  assert.deepEqual(currencyEvidenceFromApi(body, contract), {
    currency_code:'PHP', currency_symbol:'₱', currency_source:'product_list_api_currency_code', amount_scope:'all_monetary_fields',
  });
  const conflict = structuredClone(body); conflict.data.items[0].stats_v3.total.cost.currency_code = 'USD';
  assert.throws(() => currencyEvidenceFromApi(conflict, contract), { code:'currency_evidence_conflict' });
  assert.throws(() => currencyEvidenceFromApi({ data:{ items:[] } }, contract), { code:'currency_evidence_missing' });
  const page = { locator:(selector) => { assert.equal(selector, 'body'); return { innerText:async () => 'Current product report ₱10' }; } };
  await assert.rejects(() => captureProductListCurrency({ data:{ items:[] } }, page, contract), { code:'currency_evidence_missing' });
  const fallbackContract = { ...contract, fallback_source_kind:'official_report_page_symbol' };
  assert.deepEqual(await captureProductListCurrency({ data:{ items:[] } }, page, fallbackContract), {
    currency_code:'PHP', currency_symbol:'₱', currency_source:'official_report_page_symbol', amount_scope:'all_monetary_fields',
  });
  assert.throws(() => validateCurrencyContract({ ...contract, fallback_source_kind:'whole_page_any_symbol' }), { code:'currency_contract_invalid' });
});

test('mixed advertising JSON rows retain the frozen advertiser ISO currency', () => {
  assert.equal(changeLogRow('100', { id:'change-1', value:'budget' }, 'id', 'usd').at(-1), 'USD');
  assert.equal(itemsRow('100', [{ estimated_gmv:'1' }], 'usd').at(-1), 'USD');
  assert.equal(summaryRow('100', { gmv_drop_value:'1' }, 'usd').at(-1), 'USD');
});

test('currency is embedded in the delivered CSV without a sidecar', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-contract-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const shopRoot = path.join(root, 'shop');
  const dataDir = path.join(shopRoot, '店铺数据', '订单');
  fs.mkdirSync(dataDir, { recursive:true });
  const dataFile = path.join(dataDir, 'orders.csv');
  fs.writeFileSync(dataFile, Buffer.from('order_id,amount\r\n1,100\r\n'));
  const result = embedCurrency({ file:dataFile, evidence:evidence(), taskId:'currency-1' });
  assert.equal(result.status, 'success'); assert.equal(result.output_file, dataFile);
  assert.deepEqual(parseCsv(fs.readFileSync(dataFile)).rows, [
    ['order_id','amount','currency'], ['1','100','PHP'],
  ]);
  assert.equal(fs.existsSync(`${dataFile}.currency.json`), false);
});
