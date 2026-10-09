'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadReportMd } = require('../scripts/load-report-md');
const { identifyShop } = require('../scripts/common/shop_identification');
const {
  createRunSession, IDENTITY_PATH, ONBOARD_PATH, parseRunRequest,
  readAuthoritativeAdvertiser, readAuthoritativeShopIdentity,
} = require('../scripts/common/run-context');
const { resolveShopRoot } = require('../scripts/common/shop-root');

const SELLER_URL = 'https://seller-ph.tiktok.com/home';

function temporaryRoot(t, prefix = 'run-context-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeLoaded(spec) {
  return {
    router: { reports: [{ report_id: spec.report_id, aliases: ['fixture'] }], scopes: [] },
    specs: { [spec.report_id]: spec },
  };
}

function advertiserLoaded() {
  const shop = { report_id: 'shop_fixture', enabled: true, required_variables: ['shop'] };
  const advertiser = { report_id: 'advertiser_fixture', enabled: true, required_variables: ['shop', 'advertiser'] };
  return {
    router: {
      reports: [
        { report_id: shop.report_id, aliases: ['shop-fixture'] },
        { report_id: advertiser.report_id, aliases: ['advertiser-fixture'] },
      ],
      scopes: [{ aliases: ['mixed-fixtures'], report_ids: [shop.report_id, advertiser.report_id] }],
    },
    specs: { [shop.report_id]: shop, [advertiser.report_id]: advertiser },
  };
}

function onboardBody(overrides = {}) {
  return {
    code: 0,
    data: {
      seller_id: '88001', primary_adv_id: '222', bind_bc_info: { id: '33001' },
      adv_info_in_bc: [
        { id: '111', name: 'Account', currency: { name: 'USD' }, role: 0, status: 4, relation_status: 1 },
        { id: '222', name: '当前主户', currency: { name: 'PHP' }, role: 0, status: 4, relation_status: 1 },
      ],
      ...overrides,
    },
  };
}

function sellerIdentity(overrides = {}) {
  return {
    seller_id: '88001', shop_code: 'PHLOCAL001', seller_type: 2, business_type: 1,
    shop_region: 'PH', region_code: 'PH', ...overrides,
  };
}

function identityFixture(options = {}) {
  const counts = { gets: 0, identityGets: 0, onboardGets: 0, closes: 0, gotos: 0, newPages: 0 };
  let connectedReads = 0;
  const page = {
    url: () => options.pageUrl || SELLER_URL,
    goto: async () => { counts.gotos += 1; },
    request: {
      async get(url, requestOptions) {
        counts.gets += 1;
        assert.equal(requestOptions.timeout > 0, true);
        const onboardTarget = new URL(ONBOARD_PATH, SELLER_URL);
        onboardTarget.searchParams.set('oec_seller_id', '88001'); onboardTarget.searchParams.set('seller_id', '88001');
        if (url === onboardTarget.toString()) {
          counts.onboardGets += 1;
          if (options.onboardGetError) throw new Error('offline onboard injected');
          return {
            url: () => options.onboardResponseUrl || url,
            status: () => options.onboardStatus ?? 200,
            json: async () => {
              if (options.onboardJsonError) throw new Error('invalid json');
              return options.onboardBody ?? onboardBody();
            },
          };
        }
        counts.identityGets += 1;
        assert.equal(url, new URL(IDENTITY_PATH, SELLER_URL).toString());
        if (options.getError) throw new Error('offline injected');
        return {
          url: () => options.responseUrl || url,
          status: () => options.status ?? 200,
          json: async () => options.body ?? { code: 0, data: { seller: sellerIdentity() } },
        };
      },
    },
  };
  const browserContext = options.browserContext === null ? null : {
    pages: () => options.pages || [page],
    newPage: async () => { counts.newPages += 1; throw new Error('must not create page'); },
  };
  const browser = {
    contexts: () => browserContext ? [browserContext] : [],
    isConnected: () => {
      connectedReads += 1;
      return options.disconnectAfterRead ? connectedReads === 1 : options.connected !== false;
    },
    close: async () => { counts.closes += 1; },
  };
  return { browser, browserContext, counts, page };
}

function sessionDependencies(root, fixture, loaded = advertiserLoaded(), overrides = {}) {
  const a = { status: 'ready', shop_alias: '冻结店', browser_id: 'browser-7', cdp_url: 'http://127.0.0.1:9222', shop_platform_name: 'TikTok Shop后台 本土-PH' };
  const b = { status: 'operable', requested_shop_alias: '冻结店', browser_id: 'browser-7', cdp_url: a.cdp_url, seller_page_url: SELLER_URL };
  return {
    loaded, dataDepartmentRoot: root, openExactShop: async () => a, attachShop: async () => b,
    connectExistingBrowser: async () => fixture.browser,
    requestIdFactory: () => 'request-advertiser', ...overrides,
  };
}

test('shop root uses the safe shop name without appending the seller ID', (t) => {
  const root = temporaryRoot(t, 'shop-root-');
  fs.mkdirSync(path.join(root, '旧名称__88001'));
  fs.mkdirSync(path.join(root, '其他店__99001'));
  fs.writeFileSync(path.join(root, '文件__88001'), 'not a directory');
  assert.equal(resolveShopRoot(root, { shopId: '88001', shopName: '新名称' }), path.join(root, '新名称'));
  const expected = resolveShopRoot(root, { shopId: '77001', shopName: '新/店' });
  assert.equal(expected, path.join(root, '新_店'));
  assert.equal(fs.existsSync(expected), false);
});

test('shop root rejects invalid roots names and stable IDs', (t) => {
  const root = temporaryRoot(t, 'shop-root-invalid-');
  fs.mkdirSync(path.join(root, '甲__88001')); fs.mkdirSync(path.join(root, '乙__88001'));
  assert.throws(() => resolveShopRoot(root, { shopId: '88001', shopName: 'CON' }), { code: 'shop_name_invalid' });
  assert.throws(() => resolveShopRoot('relative', { shopId: '88001', shopName: '店' }), { code: 'data_department_root_invalid' });
  assert.throws(() => resolveShopRoot(path.join(root, 'missing'), { shopId: '88001', shopName: '店' }), { code: 'data_department_root_invalid' });
  assert.throws(() => resolveShopRoot(root, { shopId: 'mall-1', shopName: '店' }), { code: 'shop_id_invalid' });
});

test('request parsing expands scopes in order and separates shop ownership from advertiser execution needs', () => {
  const loaded = loadReportMd();
  const parsed = parseRunRequest({
    shop: '测试店',
    report_scopes: ['category:inventory_availability', '库存快照'],
  }, { loaded });
  assert.deepEqual(parsed.report_ids, ['inventory_snapshot']);
  assert.equal(parsed.needsAdvertiser, false); assert.equal(parsed.advertiser_ref, null);
  assert.equal(parsed.start_date, null); assert.equal(parsed.end_date, null);
  const ranged = parseRunRequest({ shop: '测试店', report_scopes: ['report:affiliate_center_performance'], start_date: '2026-08-01', end_date: '2026-08-17' }, { loaded });
  assert.deepEqual(ranged.report_ids, ['affiliate_center_performance']); assert.equal(ranged.needsAdvertiser, false);
  const explicit = parseRunRequest({ shop: '测试店', report_scopes: ['scope:inventory'], advertiser: ' １１１ ' }, { loaded });
  assert.equal(explicit.needsAdvertiser, true); assert.equal(explicit.advertiser_ref, '111');
  const creative = parseRunRequest({
    shop: '测试店', advertiser: '222', report_scopes: ['scope:inventory', 'report:affiliate_center_performance', '库存快照'],
    start_date: '2026-08-01', end_date: '2026-08-17',
  }, { loaded });
  assert.deepEqual(creative.report_ids, ['inventory_snapshot', 'affiliate_center_performance']);
  assert.equal(creative.needsAdvertiser, true); assert.equal(creative.advertiser_ref, '222');
  const campaign = parseRunRequest({
    shop: '测试店', report_scopes: ['report:gmvmax_campaign_product_daily_performance'],
    start_date: '2026-08-01', end_date: '2026-08-17', campaign: '  ＰＨ  Summer   Plan  ',
  }, { loaded });
  assert.equal(campaign.needsAdvertiser, true);
  assert.equal(campaign.campaign_ref, 'PH Summer Plan');
  const allCampaigns = parseRunRequest({
    shop: '测试店', report_scopes: ['report:gmvmax_campaign_product_daily_performance'],
    start_date: '2026-08-01', end_date: '2026-08-17',
  }, { loaded });
  assert.equal(allCampaigns.campaign_ref, null);
  const product = parseRunRequest({
    shop: '测试店', report_scopes: ['report:gmvmax_campaign_product_creative_performance'],
    start_date: '2026-08-01', end_date: '2026-08-17', product: '  Ｐｒｏｄｕｃｔ   One  ',
  }, { loaded });
  assert.equal(product.product_ref, 'Product One'); assert.equal(product.campaign_ref, null);
});

test('request alias enabled required-variable and date failures occur before opening a shop', async (t) => {
  const root = temporaryRoot(t, 'run-context-preflight-'); let opens = 0;
  const dependencies = { loaded: loadReportMd(), dataDepartmentRoot: root, openExactShop: async () => { opens += 1; throw new Error('must not open'); } };
  const invalid = [
    { request: { shop: '店', report_scopes: ['all'] }, code: 'report_alias_unknown' },
    { request: { shop: '店', report_scopes: ['default'] }, code: 'report_alias_unknown' },
    { request: { shop: '店', report_scopes: ['report:affiliate_center_performance'] }, code: 'date_range_required' },
    { request: { shop: '店', report_scopes: ['report:affiliate_center_performance'], start_date: '2026-02-30', end_date: '2026-08-17' }, code: 'date_range_invalid' },
    { request: { shop: '店', report_scopes: ['report:affiliate_center_performance'], start_date: '2026-08-18', end_date: '2026-08-17' }, code: 'date_range_invalid' },
  ];
  for (const item of invalid) await assert.rejects(() => createRunSession(item.request, dependencies), { code: item.code });
  const disabled = fakeLoaded({ report_id: 'fixture', enabled: false, required_variables: ['shop'] });
  await assert.rejects(() => createRunSession({ shop: '店', report_scopes: ['fixture'] }, { ...dependencies, loaded: disabled }), { code: 'report_disabled' });
  for (const advertiser of [{}, [], '', '   ']) {
    await assert.rejects(() => createRunSession({ shop: '店', report_scopes: ['scope:inventory'], advertiser }, dependencies), { code: 'advertiser_ref_invalid' });
  }
  for (const campaign of [{}, [], '', '   ']) {
    await assert.rejects(() => createRunSession({
      shop: '店', report_scopes: ['report:gmvmax_campaign_product_daily_performance'],
      start_date: '2026-08-01', end_date: '2026-08-17', campaign,
    }, dependencies), { code: 'campaign_ref_invalid' });
  }
  await assert.rejects(() => createRunSession({
    shop: '店', report_scopes: ['scope:inventory'], campaign: '123',
  }, dependencies), { code: 'campaign_ref_unexpected' });
  for (const product of [{}, [], '', '   ']) {
    await assert.rejects(() => createRunSession({
      shop: '店', report_scopes: ['report:gmvmax_campaign_product_creative_performance'],
      start_date: '2026-08-01', end_date: '2026-08-17', product,
    }, dependencies), { code: 'product_ref_invalid' });
  }
  await assert.rejects(() => createRunSession({
    shop: '店', report_scopes: ['report:gmvmax_campaign_daily_performance'],
    start_date: '2026-08-01', end_date: '2026-08-17', product: '999',
  }, dependencies), { code: 'product_ref_unexpected' });
  assert.equal(opens, 0);
});

test('invalid collection clock fails before opening the shop', async (t) => {
  const root = temporaryRoot(t, 'run-context-clock-'); let opens = 0;
  await assert.rejects(() => createRunSession({ shop:'店', report_scopes:['inventory_snapshot'] }, {
    loaded:loadReportMd(), dataDepartmentRoot:root, clock:() => new Date('invalid'),
    openExactShop:async () => { opens += 1; throw new Error('must not open'); },
  }), { code:'collection_date_invalid' });
  assert.equal(opens, 0);
});

test('session establishes each identity stage once freezes seller ID and closes idempotently', async (t) => {
  const root = temporaryRoot(t, 'run-session-success-'); const fixture = identityFixture();
  const counts = { config: 0, open: 0, attach: 0, identify: 0, connect: 0 };
  const a = { status: 'ready', shop_alias: '冻结店', browser_id: 'browser-7', cdp_url: 'http://127.0.0.1:9222', shop_platform_name: 'TikTok Shop后台 本土-PH' };
  const b = { status: 'operable', requested_shop_alias: '冻结店', browser_id: 'browser-7', cdp_url: a.cdp_url, seller_page_url: SELLER_URL };
  const session = await createRunSession({ shop: '店铺输入', report_scopes: ['scope:inventory', '库存快照'] }, {
    loaded: loadReportMd(),
    loadPipelineRuntimeConfig: () => { counts.config += 1; return { data_department_root: root, export_data_root: path.join(root, '99_全局生成记录_不用看', '导出运行') }; },
    openExactShop: async (value) => { counts.open += 1; assert.equal(value, '店铺输入'); return a; },
    attachShop: async (value) => { counts.attach += 1; assert.deepEqual(value, { shopAlias: '冻结店', browserId: 'browser-7', cdpUrl: a.cdp_url }); return b; },
    identifyShop: async (openResult, attachResult, identity) => {
      counts.identify += 1; assert.equal(openResult, a); assert.equal(attachResult, b);
      assert.equal(counts.connect, 1);
      assert.deepEqual(identity, sellerIdentity()); return identifyShop(openResult, attachResult, identity);
    },
    connectExistingBrowser: async (url, options) => { counts.connect += 1; assert.equal(url, a.cdp_url); assert.equal(options.attempts, 1); return fixture.browser; },
    requestIdFactory: () => 'request-001',
    clock: () => new Date('2026-08-31T16:00:00.000Z'),
  });
  assert.deepEqual(counts, { config: 1, open: 1, attach: 1, identify: 1, connect: 1 }); assert.equal(fixture.counts.gets, 1); assert.equal(fixture.counts.onboardGets, 0);
  assert.equal(session.runContext.shop_id, '88001'); assert.equal(session.runContext.seller_id, '88001'); assert.equal(session.runContext.shop.seller_id, '88001');
  assert.equal(session.runContext.provider_id, 'local'); assert.equal(session.runContext.shop_type, 'local');
  assert.equal(session.runContext.shop_code, 'PHLOCAL001'); assert.equal(session.runContext.seller_type, 2);
  assert.equal(session.runContext.business_type, 1); assert.equal(session.runContext.shop_region, 'PH');
  assert.equal(session.runContext.region_code, 'PH'); assert.equal(session.runContext.seller_hostname, 'seller-ph.tiktok.com');
  assert.equal(session.runContext.advertiser_id, null); assert.equal(session.runContext.advertiser_name, null);
  assert.equal(session.runContext.advertiser_currency, null);
  assert.equal(session.runContext.business_center_id, null);
  assert.equal(session.runContext.collection_date, '2026-09-01');
  assert.equal(session.runContext.collection_timezone, 'Asia/Manila');
  assert.deepEqual(session.runContext.report_ids, ['inventory_snapshot']);
  assert.equal(session.runContext.shop_root, path.join(root, '冻结店')); assert.equal(fs.existsSync(session.runContext.shop_root), false);
  for (const value of [session.runContext, session.runContext.report_ids, session.runContext.a, session.runContext.b, session.runContext.shop]) assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(session.browser), false); assert.equal(session.browserContext, fixture.browserContext);
  await session.close(); await session.close(); assert.equal(fixture.counts.closes, 1);
});

test('advertiser context selects current primary exact ID or one normalized full name and freezes the projection', async (t) => {
  const root = temporaryRoot(t, 'run-advertiser-success-');
  const withoutSellerIdentity = onboardBody(); delete withoutSellerIdentity.data.seller_id;
  const cases = [
    { advertiser: undefined, expectedId: '222', expectedName: '当前主户', expectedCurrency: 'PHP' },
    { advertiser: '111', expectedId: '111', expectedName: 'Account', expectedCurrency: 'USD', options: { onboardBody: withoutSellerIdentity } },
    { advertiser: ' ａｃｃｏｕｎｔ ', expectedId: '111', expectedName: 'Account', expectedCurrency: 'USD' },
  ];
  for (const item of cases) {
    const fixture = identityFixture(item.options);
    const request = { shop: '店', report_scopes: ['advertiser-fixture'], ...(item.advertiser === undefined ? {} : { advertiser: item.advertiser }) };
    const session = await createRunSession(request, sessionDependencies(root, fixture));
    assert.equal(session.runContext.advertiser_id, item.expectedId); assert.equal(session.runContext.advertiser_name, item.expectedName);
    assert.equal(session.runContext.advertiser_currency, item.expectedCurrency);
    assert.equal(session.runContext.business_center_id, '33001');
    assert.equal(Object.isFrozen(session.runContext), true); assert.equal(fixture.counts.identityGets, 1); assert.equal(fixture.counts.onboardGets, 1);
    assert.equal(fixture.counts.gotos, 0); assert.equal(fixture.counts.newPages, 0);
    await session.close(); assert.equal(fixture.counts.closes, 1);
  }
});

test('campaign and product request freezes normalized selectors after one onboard read', async (t) => {
  const root = temporaryRoot(t, 'run-campaign-context-'); const fixture = identityFixture();
  const session = await createRunSession({
    shop: '店', report_scopes: ['report:gmvmax_campaign_product_creative_performance'],
    start_date: '2026-08-01', end_date: '2026-08-17', campaign: '  Ａｌｐｈａ   Plan  ', product: ' Ｐｒｏｄｕｃｔ  One ',
  }, sessionDependencies(root, fixture, loadReportMd()));
  assert.equal(session.runContext.campaign_ref, 'Alpha Plan');
  assert.equal(session.runContext.product_ref, 'Product One');
  assert.equal(session.runContext.campaign_id, null); assert.equal(session.runContext.product_id, null);
  assert.equal(session.runContext.advertiser_id, '222'); assert.equal(session.runContext.business_center_id, '33001');
  assert.equal(session.runContext.advertiser_currency, 'PHP');
  assert.equal(fixture.counts.identityGets, 1); assert.equal(fixture.counts.onboardGets, 1);
  assert.equal(Object.isFrozen(session.runContext), true);
  await session.close(); assert.equal(fixture.counts.closes, 1);
});

test('non-target advertiser session remains valid when the selected authoritative account has no currency', async (t) => {
  const root = temporaryRoot(t, 'run-advertiser-without-currency-');
  const fixture = identityFixture({ onboardBody: onboardBody({
    adv_info_in_bc: [
      { id: '111', name: 'Account', role: 0, status: 4, relation_status: 1 },
      { id: '222', name: '当前主户', role: 0, status: 4, relation_status: 1 },
    ],
  }) });
  const session = await createRunSession({ shop: '店', report_scopes: ['advertiser-fixture'] }, sessionDependencies(root, fixture));
  assert.equal(session.runContext.advertiser_id, '222');
  assert.equal(session.runContext.advertiser_currency, null);
  assert.equal(fixture.counts.onboardGets, 1);
  await session.close();
});

test('mixed scopes and an explicit advertiser on a shop report each read onboard exactly once', async (t) => {
  const root = temporaryRoot(t, 'run-advertiser-once-');
  const cases = [
    { request: { shop: '店', report_scopes: ['mixed-fixtures'] }, loaded: advertiserLoaded() },
    { request: { shop: '店', report_scopes: ['scope:inventory'], advertiser: '111' }, loaded: loadReportMd() },
    {
      request: {
        shop: '店', report_scopes: ['scope:inventory', 'report:gmvmax_campaign_overview'],
        start_date: '2026-08-01', end_date: '2026-08-17',
      },
      loaded: loadReportMd(),
    },
  ];
  for (const item of cases) {
    const fixture = identityFixture(); const session = await createRunSession(item.request, sessionDependencies(root, fixture, item.loaded));
    assert.equal(fixture.counts.onboardGets, 1); assert.equal(fixture.counts.gets, 2);
    await session.close(); assert.equal(fixture.counts.closes, 1);
  }
});

test('advertiser selection and onboard evidence fail closed without navigation page creation or retry', async () => {
  const b = { seller_page_url: SELLER_URL };
  const eligible111 = { id: '111', name: 'Account', role: 0, status: 4, relation_status: 1 };
  const eligible222 = { id: '222', name: '当前主户', role: 0, status: 4, relation_status: 1 };
  const cases = [
    { options: {}, reference: '999', code: 'advertiser_not_found' },
    { options: { onboardBody: onboardBody({ adv_info_in_bc: [eligible111, { ...eligible222, name: 'ＡＣＣＯＵＮＴ' }] }) }, reference: 'account', code: 'advertiser_ambiguous' },
    { options: { onboardBody: onboardBody({ adv_info_in_bc: [eligible111, { ...eligible222, status: 3 }] }) }, reference: null, code: 'primary_advertiser_ineligible' },
    { options: { onboardBody: onboardBody({ adv_info_in_bc: [{ ...eligible111, status: 3 }, { ...eligible222, relation_status: 0 }] }) }, reference: null, code: 'advertiser_accounts_missing' },
    { options: { onboardBody: onboardBody({ seller_id: '99001' }) }, reference: null, code: 'advertiser_seller_identity_mismatch' },
    { options: { onboardStatus: 500 }, reference: null, code: 'advertiser_context_http_error' },
    { options: { onboardBody: { code: 1 } }, reference: null, code: 'advertiser_context_business_error' },
    { options: { onboardBody: { code: 0, data: { primary_adv_id: '222', adv_info_in_bc: [{}] } } }, reference: null, code: 'advertiser_context_shape_invalid' },
    { options: { onboardBody: onboardBody({ bind_bc_info: null }) }, reference: null, code: 'advertiser_context_shape_invalid' },
    { options: { onboardBody: onboardBody({ bind_bc_info: { id: 'bc-1' } }) }, reference: null, code: 'advertiser_context_shape_invalid' },
    { options: { onboardJsonError: true }, reference: null, code: 'advertiser_context_response_invalid' },
    { options: { onboardResponseUrl: 'https://seller-ph.tiktok.com/oec_ads/shopping/v1/oec/get_onboard_info?oec_seller_id=99001&seller_id=99001' }, reference: null, code: 'advertiser_context_response_invalid' },
    { options: { onboardGetError: true }, reference: null, code: 'advertiser_context_transport_failed' },
  ];
  for (const item of cases) {
    const fixture = identityFixture(item.options);
    await assert.rejects(() => readAuthoritativeAdvertiser(fixture.browser, fixture.browserContext, b, '88001', item.reference), { code: item.code });
    assert.equal(fixture.counts.onboardGets, 1); assert.equal(fixture.counts.gets, 1);
    assert.equal(fixture.counts.gotos, 0); assert.equal(fixture.counts.newPages, 0);
  }
});

test('onboard transport failure does not reconnect and closes the connected browser exactly once', async (t) => {
  const root = temporaryRoot(t, 'run-advertiser-failure-'); const fixture = identityFixture({ onboardGetError: true }); let connects = 0;
  await assert.rejects(() => createRunSession({ shop: '店', report_scopes: ['advertiser-fixture'] }, sessionDependencies(root, fixture, advertiserLoaded(), {
    connectExistingBrowser: async () => { connects += 1; return fixture.browser; },
  })), { code: 'advertiser_context_transport_failed' });
  assert.equal(connects, 1); assert.equal(fixture.counts.identityGets, 1); assert.equal(fixture.counts.onboardGets, 1);
  assert.equal(fixture.counts.gotos, 0); assert.equal(fixture.counts.newPages, 0); assert.equal(fixture.counts.closes, 1);

  const invalidBc = identityFixture({ onboardBody: onboardBody({ bind_bc_info: {} }) });
  await assert.rejects(() => createRunSession(
    { shop: '店', report_scopes: ['advertiser-fixture'] },
    sessionDependencies(root, invalidBc),
  ), { code: 'advertiser_context_shape_invalid' });
  assert.equal(invalidBc.counts.onboardGets, 1); assert.equal(invalidBc.counts.closes, 1);
});

test('authoritative identity read is one active GET with no retry and fails closed on invalid evidence', async () => {
  const cases = [
    { options: { status: 500 }, code: 'shop_identity_http_error', gets: 1 },
    { options: { body: { code: 1 } }, code: 'shop_identity_business_error', gets: 1 },
    { options: { body: { code: 0, data: { seller: { seller_id: 'mall-1' } } } }, code: 'shop_identity_invalid', gets: 1 },
    { options: { body: { code: 0, data: { seller: sellerIdentity({ shop_code: '' }) } } }, code: 'shop_identity_invalid', gets: 1 },
    { options: { body: { code: 0, data: { seller: sellerIdentity({ seller_type: '2' }) } } }, code: 'shop_identity_invalid', gets: 1 },
    { options: { pageUrl: 'https://seller-ph.tiktok.com/account/login' }, code: 'seller_login_page', gets: 0 },
    { options: { responseUrl: 'https://evil.example/api/v3/seller/common/get' }, code: 'seller_origin_mismatch', gets: 1 },
    { options: { browserContext: null }, code: 'browser_context_missing', gets: 0 },
    { options: { disconnectAfterRead: true }, code: 'browser_disconnected', gets: 1 },
    { options: { getError: true }, code: 'shop_identity_read_failed', gets: 1 },
  ];
  for (const item of cases) {
    const fixture = identityFixture(item.options);
    await assert.rejects(() => readAuthoritativeShopIdentity(fixture.browser, fixture.browserContext, { seller_page_url: SELLER_URL }), { code: item.code });
    assert.equal(fixture.counts.gets, item.gets);
  }
  const valid = identityFixture();
  assert.deepEqual(await readAuthoritativeShopIdentity(valid.browser, valid.browserContext, { seller_page_url: SELLER_URL }), sellerIdentity());
  assert.equal(valid.counts.gets, 1);
});

test('session failure after connection closes the browser exactly once', async (t) => {
  const root = temporaryRoot(t, 'run-session-failure-'); const fixture = identityFixture({ body: { code: 1 } });
  const a = { status: 'ready', shop_alias: '店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222' };
  const b = { status: 'operable', requested_shop_alias: '店', browser_id: '7', cdp_url: a.cdp_url, seller_page_url: SELLER_URL };
  await assert.rejects(() => createRunSession({ shop: '店', report_scopes: ['scope:inventory'] }, {
    dataDepartmentRoot: root, openExactShop: async () => a, attachShop: async () => b,
    identifyShop: async () => ({ status: 'identified', provider_id: 'local' }), connectExistingBrowser: async () => fixture.browser,
  }), { code: 'shop_identity_business_error' });
  assert.equal(fixture.counts.gets, 1); assert.equal(fixture.counts.closes, 1);

  const unsupported = identityFixture({ body: { code: 0, data: { seller: sellerIdentity({ seller_type: 9, business_type: 9 }) } } });
  await assert.rejects(() => createRunSession(
    { shop: '店', report_scopes: ['scope:inventory'] },
    sessionDependencies(root, unsupported, loadReportMd()),
  ), { code: 'unsupported_shop_type' });
  assert.equal(unsupported.counts.identityGets, 1); assert.equal(unsupported.counts.closes, 1);
});

test('provider runner requires and uses the borrowed browser context without closing it', async (t) => {
  const root = temporaryRoot(t, 'runner-abi-'); const specs = loadReportMd().specs;
  const identity = { status: 'ready', shop_alias: '店', browser_id: '7', cdp_url: 'http://127.0.0.1:9222' };
  const b = { ...identity, status: 'operable', requested_shop_alias: '店', seller_page_url: SELLER_URL };
  const shop = { ...identity, status: 'identified', provider_id: 'local', seller_id: '88001' };
  const runners = [['inventory_snapshot', require('../scripts/routes/local/inventory_snapshot'), 'run', { providerSpec: specs.inventory_snapshot.providers.local }]];
  for (const [reportId, runner, exportName, extra] of runners) {
    assert.equal(runner.run, runner[exportName]);
    const input = { a: identity, b, shop, reportSpec: specs[reportId], outputDir: path.join(root, reportId), ...extra };
    let connects = 0;
    const connect = async () => { connects += 1; throw new Error('fallback connect called'); };
    await assert.rejects(() => runner.run(input, { connect }), { code: 'browser_disconnected' });
    const context = { pages: () => [] }; const decoy = { pages: () => { throw new Error('wrong context used'); } }; let closes = 0;
    const browser = { isConnected: () => true, contexts: () => [decoy, context], close: async () => { closes += 1; } };
    await assert.rejects(() => runner.run(input, { browser, connect }), { code: 'browser_context_missing' });
    let foreignPages = 0;
    const foreignContext = { pages: () => { foreignPages += 1; throw new Error('foreign context used'); } };
    await assert.rejects(() => runner.run(input, { browser, browserContext: foreignContext, connect }), { code: 'browser_context_missing' });
    assert.equal(foreignPages, 0);
    await assert.rejects(() => runner.run(input, { browser, browserContext: context, connect }), { code: 'seller_page_missing' });
    assert.equal(connects, 0); assert.equal(closes, 0);
  }
});
