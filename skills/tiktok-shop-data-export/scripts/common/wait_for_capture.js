'use strict';

async function waitForCapture(page, complete, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 20000); const pollMs = Number(options.pollMs ?? 100); const clock = options.clock || Date.now;
  const deadline = clock() + timeoutMs;
  while (!complete()) {
    const remaining = deadline - clock();
    if (remaining <= 0) return false;
    await page.waitForTimeout(Math.min(pollMs, remaining));
  }
  return true;
}

module.exports = { waitForCapture };
