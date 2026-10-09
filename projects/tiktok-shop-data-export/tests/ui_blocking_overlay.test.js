'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { dismissBlockingOverlay, validateBlockingOverlay } = require('../scripts/common/ui-blocking-overlay');

const contract = { dialog_selector:'[role="dialog"]:visible', button_pattern:'^(?:Got it|知道了|好的)$', max_attempts:2, timeout_ms:100 };

function locator(items) {
  return { count:async()=>items.length, nth:(index)=>items[index] };
}

function scenario({ dialogs = 0, buttonTexts = [], hideFails = false } = {}) {
  let clicks = 0; let hidden = false;
  const buttons = buttonTexts.map((value)=>({ isVisible:async()=>true, innerText:async()=>value, click:async()=>{clicks+=1;if(!hideFails)hidden=true;} }));
  const dialog = { isVisible:async()=>!hidden, getByRole:()=>locator(buttons), waitFor:async()=>{if(hideFails)throw new Error('timeout');} };
  const page = { locator:()=>locator(Array.from({length:dialogs},()=>dialog)) };
  return { page, clicks:()=>clicks };
}

test('blocking overlay contract is explicit and rejects malformed patterns', () => {
  assert.equal(validateBlockingOverlay(contract), true);
  assert.equal(validateBlockingOverlay({...contract,button_pattern:'['}), false);
  assert.equal(validateBlockingOverlay({...contract,max_attempts:0}), false);
});

test('blocking overlay helper is a no-op without a visible dialog', async () => {
  const value=scenario();assert.equal(await dismissBlockingOverlay(value.page,contract),0);assert.equal(value.clicks(),0);
});

test('blocking overlay helper clicks exactly one whitelisted button', async () => {
  const value=scenario({dialogs:1,buttonTexts:['Cancel','Got it']});assert.equal(await dismissBlockingOverlay(value.page,contract),1);assert.equal(value.clicks(),1);
});

test('blocking overlay helper fails closed for unknown or ambiguous UI', async () => {
  const unknown=scenario({dialogs:1,buttonTexts:['Continue']});await assert.rejects(()=>dismissBlockingOverlay(unknown.page,contract),{code:'ui_blocking_overlay_contract_changed'});assert.equal(unknown.clicks(),0);
  const ambiguous=scenario({dialogs:2,buttonTexts:['Got it']});await assert.rejects(()=>dismissBlockingOverlay(ambiguous.page,contract),{code:'ui_blocking_overlay_ambiguous'});assert.equal(ambiguous.clicks(),0);
  const stuck=scenario({dialogs:1,buttonTexts:['好的'],hideFails:true});await assert.rejects(()=>dismissBlockingOverlay(stuck.page,contract),{code:'ui_blocking_overlay_not_dismissed'});assert.equal(stuck.clicks(),1);
});
