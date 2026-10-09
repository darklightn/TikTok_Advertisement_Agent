'use strict';

const fs = require('fs');
const path = require('path');
const { safeSegment } = require('./file-check');
const { inside } = require('./md-spec-validator');

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/gu;
const DATE_VARIABLES = new Set(['start_date', 'end_date']);
const SEGMENT_VARIABLES = new Set([
  'shop_name', 'advertiser_name', 'campaign_name', 'product_name',
  'logical_table', 'time_file', 'segment_file',
]);

function fail(code, details = {}) {
  throw Object.assign(new Error(code), { code, details });
}

function safeValue(value, code, variable, maxLength = 100) {
  try {
    return safeSegment(value, maxLength);
  } catch {
    fail(code, { variable });
  }
}

function renderVariable(variable, value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    fail('output_path_variable_missing', { variable });
  }
  const text = String(value).normalize('NFKC').trim();
  if (DATE_VARIABLES.has(variable)) {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || Number.isNaN(parsed.valueOf())
      || parsed.toISOString().slice(0, 10) !== text) fail('output_path_date_invalid', { variable });
    return text;
  }
  if (variable.endsWith('_id')) {
    if (['advertiser_id', 'campaign_id', 'product_id'].includes(variable) && !/^\d+$/u.test(text)) fail('output_path_id_invalid', { variable });
    const cleaned = safeValue(text, 'output_path_id_invalid', variable);
    if (cleaned !== text) fail('output_path_id_invalid', { variable });
    return text;
  }
  if (SEGMENT_VARIABLES.has(variable)) {
    return safeValue(text, 'output_path_segment_invalid', variable, variable === 'time_file' ? 180 : 100);
  }
  fail('output_path_variable_unsupported', { variable });
}

function pathComponents(root, target) {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('output_path_escape');
  const components = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); components.push(current);
  }
  return components;
}

function lstat(io, target) {
  try { return io.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function hasExistingLink(root, target) {
  for (const component of pathComponents(root, target)) {
    const stat = lstat(fs, component);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return false;
  }
  return false;
}

function validatePhysicalOutputPath(destination, shopRoot, options = {}) {
  const io = options.fs || fs;
  const resolvedShopRoot = path.resolve(shopRoot);
  const resolvedDestination = path.resolve(destination);
  const destinationParent = path.dirname(resolvedDestination);
  if (!inside(resolvedShopRoot, resolvedDestination) || resolvedDestination === resolvedShopRoot) fail('output_path_escape');

  for (const component of pathComponents(resolvedShopRoot, destinationParent)) {
    const stat = lstat(io, component);
    if (!stat) {
      if (options.requireExistingParent) fail('output_path_parent_invalid');
      break;
    }
    if (stat.isSymbolicLink()) fail('output_path_link_unsupported');
    if (!stat.isDirectory()) fail('output_path_parent_invalid');
  }
  if (!options.requireExistingParent) return;

  let physicalShopRoot; let physicalParent;
  try {
    physicalShopRoot = io.realpathSync(resolvedShopRoot);
    physicalParent = io.realpathSync(destinationParent);
  } catch { fail('output_path_parent_invalid'); }
  if (!inside(physicalShopRoot, physicalParent)) fail('output_path_physical_escape');
}

function renderOutputPath(spec, shopRoot, variables = {}) {
  if (!spec || typeof spec.output_path_template !== 'string' || !path.isAbsolute(shopRoot || '')) {
    fail('output_path_input_invalid');
  }
  const template = spec.output_path_template;
  if (template.includes('\\') || template.includes('//') || template.startsWith('/')
    || !/^(?:店铺数据|广告户数据|计划数据)\//u.test(template)) fail('output_path_template_invalid');
  const rendered = template.replace(PLACEHOLDER, (_, variable) => renderVariable(variable, variables[variable]));
  if (rendered.includes('{{') || rendered.includes('}}')) fail('output_path_unresolved_placeholder');
  const segments = rendered.split('/');
  if (segments.length !== 3 || segments.some((segment) => !segment)) fail('output_path_template_invalid');
  for (const [index, segment] of segments.entries()) {
    const maxLength = index === segments.length - 1 ? 180 : 100;
    if (safeValue(segment, 'output_path_segment_invalid', null, maxLength) !== segment) fail('output_path_segment_invalid');
  }
  const destination = path.resolve(shopRoot, ...segments);
  if (!inside(shopRoot, destination) || destination === path.resolve(shopRoot)) fail('output_path_escape');
  return destination;
}

module.exports = { renderOutputPath, validatePhysicalOutputPath };
