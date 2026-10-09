'use strict';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertExportControlReady(control, reasonCode, options = {}) {
  try {
    const shouldWait = options.wait === true;
    const deadline = shouldWait ? Date.now() + options.timeoutMs : 0;
    if (shouldWait) await control.waitFor({ state: 'visible', timeout: options.timeoutMs });
    while (true) {
      if (await control.count() === 1 && await control.isVisible() && await control.isEnabled()) return control;
      if (!shouldWait || Date.now() >= deadline) fail(reasonCode);
      await wait(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  } catch (error) {
    if (error?.code === reasonCode) throw error;
    fail(reasonCode);
  }
}

async function resolveExportControl(page, selector, reasonCode, timeoutMs) {
  const control = page.locator(selector);
  return assertExportControlReady(control, reasonCode, { wait: true, timeoutMs });
}

module.exports = { assertExportControlReady, resolveExportControl };
