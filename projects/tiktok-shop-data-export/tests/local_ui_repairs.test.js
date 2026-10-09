'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadReportMd } = require('../scripts/load-report-md');
const orders = require('../scripts/routes/local/manage_orders_csv');
const affiliate = require('../scripts/routes/local/affiliate_center_performance');

test('orders dismisses a late official popup before opening export, with no duplicate submission', async () => {
  const ui = loadReportMd().specs.manage_orders_csv.providers.local.official_validation.ui_contract;
  let state = 'initial'; let opens = 0; let dismissals = 0;
  const exported = { locator:()=>({count:async()=>ui.radio_count}), getByRole:()=>({count:async()=>1}) };
  const popup = { locator:()=>({count:async()=>0}), getByRole:(_role,opts)=>opts ? {click:async()=>{dismissals++;state='clear';}} : {allInnerTexts:async()=>['Got it']}, waitFor:async()=>{} };
  const entry = { click:async opts=>{ if (state==='initial') { state='popup'; throw Object.assign(new Error('intercepted'),{name:'TimeoutError'}); } if (!opts.trial) {opens++;state='export';} } };
  const page = { locator:()=>({count:async()=>['popup','export'].includes(state)?1:0,nth:()=>state==='popup'?popup:exported,first:()=>({waitFor:async()=>{}})}),getByRole:()=>({first:()=>entry}) };
  assert.equal(await orders.exportDialog(page,ui),exported);
  assert.equal(opens,1); assert.equal(dismissals,1);
});

test('orders does not bypass an unknown blocking dialog', async()=>{
  const ui=loadReportMd().specs.manage_orders_csv.providers.local.official_validation.ui_contract;
  let clicks=0;
  const dialog={locator:()=>({count:async()=>0}),getByRole:()=>({allInnerTexts:async()=>['Authorize payment'],click:async()=>{clicks++;}})};
  await assert.rejects(orders.exportDialog({locator:()=>({count:async()=>1,nth:()=>dialog})},ui),{code:'blocking_modal_contract_changed'});
  assert.equal(clicks,0);
});

function navigationHarness(options={}) {
  const rules = {...loadReportMd().specs.affiliate_center_performance.providers.local.official_validation,request_timeout_ms:100};
  const origin='https://affiliate.tiktok.com'; const id='7496176775586483191'; const clicks=[];
  let sellerUrl=rules.seller_origin+'/home';
  const label=(name,action)=>{const target={count:async()=>1,evaluate:async fn=>fn.toString().includes('element.click()')?action():name,click:async()=>action()};const item={isVisible:async()=>true,locator:()=>target};return {count:async()=>1,nth:()=>item,first:()=>({waitFor:async()=>{clicks.push('ready:'+name);}})};};
  const page={url:()=>origin+'/affiliate/platform/homepage?shop_region=PH&shop_id='+(options.wrongShop?'99':id),getByText:pattern=>label(String(pattern),()=>clicks.push('affiliate-step'))};
  const stale={url:()=>origin+'/affiliate/platform/homepage?shop_region=PH&shop_id=stale',getByText:()=>{throw new Error('must not reuse old tab');}};
  const pages=[];
  const seller={url:()=>sellerUrl,getByText:()=>label('seller',()=>{sellerUrl=rules.seller_origin+rules.seller_landing_path+'?shop_region=PH';}),getByRole:(_role,{name})=>({count:async()=>1,isVisible:async()=>true,click:async()=>{assert.equal(name,rules.seller_landing_button);clicks.push('landing');pages.push(page);}})};
  pages.push(seller,stale);
  return {rules,clicks,run:()=>affiliate.navigateAffiliate({shop:{seller_id:id}},{browserContext:{pages:()=>pages},dismissBlockingOverlay:async()=>{}},rules,origin,async()=>{})};
}

test('local affiliate uses observed Seller landing button, ignores stale tab and waits for mounted navigation', async()=>{
  const h=navigationHarness();const page=await h.run();assert.match(page.url(),/shop_id=7496176775586483191$/);
  assert.equal(h.clicks.filter(x=>x==='landing').length,1);assert.equal(h.clicks.filter(x=>x==='affiliate-step').length,2);assert.equal(h.clicks.filter(x=>x.startsWith('ready:')).length,2);
});
test('local affiliate rejects newly opened wrong-shop page before analytics or export',async()=>{
  const h=navigationHarness({wrongShop:true});await assert.rejects(h.run(),{code:'result_shop_identity_mismatch'});assert.deepEqual(h.clicks,['landing']);
});

test('local creative discovery owns a fresh route page and closes it on failure without closing Seller',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'creative-route-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const spec=loadReportMd().specs.gmvmax_campaign_product_creative_performance,provider=spec.providers.local;
  let routeClosed=0,sellerClosed=0,created=0;
  const seller={url:()=>provider.response_origin+'/home',close:async()=>{sellerClosed++;},goto:async()=>{throw Error('do not reuse Seller drawer');}};
  const route={goto:async()=>{throw Object.assign(new Error('probe_stop'),{code:'probe_stop'});},close:async()=>{routeClosed++;}};
  const context={pages:()=>[seller,route],newPage:async()=>{created++;return route;}};
  const input={a:{},b:{seller_page_url:seller.url()},shop:{seller_id:'123',provider_id:'local'},reportSpec:spec,providerSpec:provider,advertiserId:'456',businessCenterId:'789',startDate:'2026-08-01',endDate:'2026-08-17',outputDir:root};
  await assert.rejects(require('../scripts/routes/local/gmvmax_campaign_product_creative_performance').run(input,{browser:{isConnected:()=>true,contexts:()=>[context]},browserContext:context}),{code:'probe_stop'});
  assert.equal(created,1);assert.equal(routeClosed,1);assert.equal(sellerClosed,0);
});
