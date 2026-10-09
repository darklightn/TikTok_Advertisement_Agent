'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { waitForCapture } = require('../scripts/common/wait_for_capture');

test('capture wait exits as soon as every required response is present', async () => {
  let now = 0; let waits = 0; let captured = 0;
  const page = { waitForTimeout: async (ms) => { waits += 1; now += ms; captured += 1; } };
  const complete = await waitForCapture(page, () => captured >= 2, { timeoutMs: 20000, pollMs: 100, clock: () => now });
  assert.equal(complete, true);
  assert.equal(waits, 2);
  assert.equal(now, 200);
});

test('capture wait retains the old fixed duration only as a timeout ceiling', async () => {
  let now = 0;
  const page = { waitForTimeout: async (ms) => { now += ms; } };
  const complete = await waitForCapture(page, () => false, { timeoutMs: 250, pollMs: 100, clock: () => now });
  assert.equal(complete, false);
  assert.equal(now, 250);
});
