'use strict';

const crypto = require('crypto');
const fs = require('fs');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function safeSegment(value, maxLength = 100) {
  const text = String(value || '').normalize('NFKC').trim();
  const cleaned = text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..' || RESERVED.test(cleaned)) fail('unsafe_path_segment');
  if (cleaned.length <= maxLength) return cleaned;
  const tailLength = Math.floor(maxLength / 3);
  return `${cleaned.slice(0, maxLength - tailLength - 1)}~${cleaned.slice(-tailLength)}`;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = { safeSegment, sha256File };
