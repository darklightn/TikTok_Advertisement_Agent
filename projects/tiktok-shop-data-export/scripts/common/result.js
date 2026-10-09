'use strict';

function unavailableCapability(component) {
  if (typeof component !== 'string' || component.length === 0) {
    throw new TypeError('component must be a non-empty string');
  }
  return {
    schema_version: 'capability_gate_v1',
    component,
    status: 'blocked',
    reason_code: 'capability_not_available',
  };
}

function writeJsonLine(value, stream = process.stdout) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('result must be an object');
  }
  stream.write(`${JSON.stringify(value)}\n`);
}

module.exports = { unavailableCapability, writeJsonLine };
