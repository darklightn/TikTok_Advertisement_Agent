'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadReportMd } = require('../scripts/load-report-md');
const { readFirstWorksheet } = require('../scripts/common/xlsx_first_sheet');
const returns = require('../scripts/routes/local/returns_refunds_snapshot');
const recommendation = require('../scripts/routes/local/gmvmax_campaign_recommendation_snapshot');
const SELLER = '7496176775586483191';
const ORIGIN = 'https://seller-ph.tiktok.com';
const loaded = loadReportMd();

function stage(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'current-report-repair-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function card(id) { return { biz_data: { reverse_main_order_id: String(id), return_price: '₱10' }, card: {} }; }
function harness(t, reply, total = 3) {
  const spec = structuredClone(loaded.specs.returns_refunds_snapshot);
  spec.providers.local.api_contract.request_body.count = 2;
  const requests = []; let connected = true; let current = ORIGIN + '/homepage';
  const page = { url: () => current, request: { post: async (url, options) => {
    requests.push({ url, options });
    const offset = options.data.offset;
    const result = reply?.({ url, options, index: requests.length - 1, disconnect: () => { connected = false; }, navigate: (value) => { current = value; } }) || {};
    return { status: () => result.status || 200, url: () => result.url || url,
      json: async () => result.body || { code: 0, data: { total_count: total, cards: Array.from({ length: Math.min(2, total - offset) }, (_, i) => card(offset + i + 1)) } } };
  } } };
  const context = { pages: () => [page] };
  const browser = { isConnected: () => connected, contexts: () => [context] };
  const outputDir = path.join(stage(t), 'staging');
  const input = { reportSpec: spec, providerSpec: spec.providers.local, outputDir, a: { shop_alias: 'Test' }, b: { seller_page_url: page.url() }, shop: { seller_id: SELLER, provider_id: 'local' } };
  return { requests, outputDir, run: () => returns.run(input, { browser, browserContext: context }) };
}

test('local returns uses verified offset POST without UI, freezes filters, and rechecks head', async t => {
  const h = harness(t); const result = await h.run();
  assert.equal(result.status, 'success'); assert.equal(result.row_count, 3);
  assert.deepEqual(h.requests.map(r => r.options.data.offset), [0, 2, 0]);
  const fixed = ({ offset, ...body }) => body;
  assert.ok(h.requests.every(r => JSON.stringify(fixed(r.options.data)) === JSON.stringify(fixed(h.requests[0].options.data))));
  for (const r of h.requests) for (const key of ['seller_id', 'oec_seller_id']) assert.equal(new URL(r.url).searchParams.get(key), SELLER);
  const sheet = readFirstWorksheet(fs.readFileSync(result.output_file));
  assert.equal(sheet.rows.length, 4); assert.equal(sheet.rows[1][10], 'PHP');
});

test('local returns trusts only an API zero and keeps its empty workbook contract', async t => {
  const h = harness(t, () => ({ body: { code: 0, data: { total_count: 0 } } }), 0);
  const result = await h.run(); assert.equal(result.status, 'no_data'); assert.equal(result.row_count, 0);
  assert.equal(h.requests.length, 1); assert.equal(readFirstWorksheet(fs.readFileSync(result.output_file)).rows.length, 1);
});

test('local returns rejects incomplete pages, repeats, drifting totals and changed final head before writing', async t => {
  const cases = [
    ['duplicate_id', 1, { total_count: 3, cards: [card(1)] }, 'returns_refunds_collection_incomplete'],
    ['missing_id', 1, { total_count: 3, cards: [card('')] }, 'returns_refunds_collection_incomplete'],
    ['short_page', 0, { total_count: 3, cards: [card(1)] }, 'returns_refunds_collection_incomplete'],
    ['empty_page', 1, { total_count: 3, cards: [] }, 'returns_refunds_page_invalid'],
    ['total_drift', 1, { total_count: 4, cards: [card(3)] }, 'returns_refunds_total_drift'],
    ['final_total_drift', 2, { total_count: 4, cards: [card(1), card(2)] }, 'returns_refunds_total_drift'],
    ['final_head_drift', 2, { total_count: 3, cards: [card(2), card(1)] }, 'returns_refunds_snapshot_drift'],
  ];
  for (const [name, index, data, code] of cases) {
    const h = harness(t, r => r.index === index ? { body: { code: 0, data } } : null);
    await assert.rejects(h.run, e => { assert.equal(e.code, code, name); assert.ok(e.diagnostics.stage); return true; });
    assert.equal(fs.existsSync(h.outputDir), false, name);
  }
});

test('local returns treats seller/transport/session drift as fatal evidence', async t => {
  for (const [mutate, code] of [
    [r => { const url = new URL(r.url); url.searchParams.set('seller_id', '99'); return { url: url.href }; }, 'returns_refunds_identity_mismatch'],
    [() => ({ url: 'https://example.com/orders' }), 'seller_origin_mismatch'],
    [() => ({ status: 401 }), 'transport_login_required'],
    [r => { r.disconnect(); return {}; }, 'browser_disconnected'],
  ]) { const h = harness(t, mutate); await assert.rejects(h.run, { code }); assert.equal(fs.existsSync(h.outputDir), false); }
});

function item(id = '100') { return { entity_type: 2, apply_entity: { type: 2, id }, content: { meta: { campaign_id: id } } }; }
function recBody(items) { return { code: 0, data: { items, summary: {} } }; }
const contract = loaded.specs.gmvmax_campaign_recommendation_snapshot.providers.local.api_contract;

test('local flash-sale recommendation uses typed campaign evidence without optional metadata ID', () => {
  const flash = item(); flash.content.meta = { spu_list: ['200', '201'] };
  const result = recommendation.recommendationData(recBody([flash, item()]), contract, '100');
  assert.equal(result.items.length, 2); assert.deepEqual(result.items[0], flash);
});

test('recommendation distinguishes malformed evidence from explicit campaign conflicts with redacted diagnostics', () => {
  const samples = [
    [null, 'campaign_recommendation_shape_invalid', 'items.0', 'invalid_item'],
    [{ ...item(), apply_entity: { type: 2 } }, 'campaign_recommendation_shape_invalid', 'apply_entity.id', 'missing_campaign_evidence'],
    [{ ...item(), apply_entity: { type: 2, id: null } }, 'campaign_recommendation_shape_invalid', 'apply_entity.id', 'invalid_id_type'],
    [{ ...item(), entity_type: 3 }, 'campaign_recommendation_shape_invalid', 'entity_type', 'unsupported_entity_type'],
    [{ ...item(), apply_entity: { type: 2, id: '999' } }, 'campaign_recommendation_plan_conflict', 'apply_entity.id', 'plan_conflict'],
    [{ ...item(), content: { meta: { campaign_id: '999' } } }, 'campaign_recommendation_plan_conflict', 'content.meta.campaign_id', 'plan_conflict'],
  ];
  for (const [value, code, field, kind] of samples) assert.throws(() => recommendation.recommendationData(recBody([value]), contract, '100'), e => {
    assert.equal(e.code, code); assert.equal(e.diagnostics.field_path, field); assert.equal(e.diagnostics.failure_kind, kind);
    assert.equal(e.diagnostics.item_index, 0); assert.ok(e.diagnostics.actual_type);
    assert.equal(e.diagnostics.expected_id, undefined); assert.equal(e.diagnostics.actual_id, undefined); return true;
  });
});
