'use strict';

const crypto = require('crypto');

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error('canonical_json_non_finite_number'), { code: 'canonical_json_non_finite_number' });
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw Object.assign(new Error('canonical_json_unsupported_value'), { code: 'canonical_json_unsupported_value' });
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}

module.exports = { canonicalize, stableId };
