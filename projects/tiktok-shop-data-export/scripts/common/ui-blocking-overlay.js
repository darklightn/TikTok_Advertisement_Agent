'use strict';

function codedError(code) { return Object.assign(new Error(code), { code }); }
function text(value) { return typeof value === 'string' && Boolean(value.trim()); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function validateBlockingOverlay(contract) {
  if (!object(contract)
    || !text(contract.dialog_selector)
    || !text(contract.button_pattern)
    || !Number.isInteger(contract.max_attempts) || contract.max_attempts < 1
    || !Number.isInteger(contract.timeout_ms) || contract.timeout_ms < 1) return false;
  try { new RegExp(contract.button_pattern, 'iu'); } catch { return false; }
  return true;
}

async function visible(locator) {
  const result = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible()) result.push(item);
  }
  return result;
}

async function dismissBlockingOverlay(page, contract) {
  if (!validateBlockingOverlay(contract)) throw codedError('ui_blocking_overlay_contract_invalid');
  const pattern = new RegExp(contract.button_pattern, 'iu');
  for (let attempt = 0; attempt < contract.max_attempts; attempt += 1) {
    const dialogs = await visible(page.locator(contract.dialog_selector));
    if (!dialogs.length) return attempt;
    if (dialogs.length !== 1) throw codedError('ui_blocking_overlay_ambiguous');
    const buttons = await visible(dialogs[0].getByRole('button'));
    const matching = [];
    for (const button of buttons) {
      if (pattern.test(String(await button.innerText()).trim())) matching.push(button);
    }
    if (matching.length !== 1) throw codedError('ui_blocking_overlay_contract_changed');
    await matching[0].click();
    try { await dialogs[0].waitFor({ state:'hidden', timeout:contract.timeout_ms }); }
    catch { throw codedError('ui_blocking_overlay_not_dismissed'); }
  }
  if ((await visible(page.locator(contract.dialog_selector))).length) throw codedError('ui_blocking_overlay_not_dismissed');
  return contract.max_attempts;
}

module.exports = { dismissBlockingOverlay, validateBlockingOverlay };
