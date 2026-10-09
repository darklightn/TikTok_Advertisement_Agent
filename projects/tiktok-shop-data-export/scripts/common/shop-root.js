'use strict';

const fs = require('fs');
const path = require('path');
const { safeSegment } = require('./file-check');

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function resolveShopRoot(dataDepartmentRoot, { shopId, shopName } = {}) {
  if (!path.isAbsolute(dataDepartmentRoot || '') || !fs.statSync(dataDepartmentRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail('data_department_root_invalid');
  }
  const root = path.resolve(dataDepartmentRoot);
  const stableId = String(shopId || '').trim();
  if (!/^\d+$/u.test(stableId)) fail('shop_id_invalid');
  let safeName;
  try { safeName = safeSegment(shopName); } catch { fail('shop_name_invalid'); }
  const resolved = path.join(root, safeName);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('shop_directory_escape');
  return resolved;
}

module.exports = { resolveShopRoot };
