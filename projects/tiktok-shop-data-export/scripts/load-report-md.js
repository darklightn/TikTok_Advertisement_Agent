'use strict';

const fs = require('fs');
const path = require('path');
const {
  inside,
  normalizedAlias,
  validateReportRouter,
  validateReportSpec,
} = require('./common/md-spec-validator');

const DEFAULT_SKILL_ROOT = path.resolve(__dirname, '..');
const MARKERS = Object.freeze({
  router: ['<!-- report-router:start -->', '<!-- report-router:end -->'],
  spec: ['<!-- report-spec:start -->', '<!-- report-spec:end -->'],
});

function fail(code, details = {}) { throw Object.assign(new Error(code), { code, details }); }
function read(file, code) { try { return fs.readFileSync(file, 'utf8'); } catch { fail(code, { path: file }); } }
function jsonPayload(block, code) {
  let value = block.trim();
  if (value.startsWith('```')) {
    const fenced = value.match(/^```json\s*\r?\n([\s\S]*?)\r?\n```$/u);
    if (!fenced) fail(code);
    value = fenced[1];
  }
  try { return JSON.parse(value); } catch { fail(code); }
}

function markedBlockEntries(markdown, kind) {
  const markers = MARKERS[kind];
  if (!markers || typeof markdown !== 'string') fail(`report_${kind}_marker_invalid`);
  const [start, end] = markers; const blocks = []; let cursor = 0;
  while (cursor < markdown.length) {
    const startAt = markdown.indexOf(start, cursor); const strayEnd = markdown.indexOf(end, cursor);
    if (startAt < 0) {
      if (strayEnd >= 0) fail(`report_${kind}_marker_invalid`);
      break;
    }
    if (strayEnd >= 0 && strayEnd < startAt) fail(`report_${kind}_marker_invalid`);
    const endAt = markdown.indexOf(end, startAt + start.length);
    const nestedStartAt = markdown.indexOf(start, startAt + start.length);
    const hasNestedStart = nestedStartAt >= 0 && nestedStartAt < endAt;
    if (endAt < 0 || hasNestedStart) fail(`report_${kind}_marker_invalid`);
    blocks.push({ content: markdown.slice(startAt + start.length, endAt), startAt, endAt }); cursor = endAt + end.length;
  }
  if (!blocks.length) fail(`report_${kind}_marker_missing`);
  return blocks;
}
function markedBlocks(markdown, kind) { return markedBlockEntries(markdown, kind).map((entry) => entry.content); }

function reportSpecSections(markdown) {
  const sections = new Set();
  return markedBlockEntries(markdown, 'spec').map((entry) => {
    const before = markdown.slice(0, entry.startAt);
    const heading = before.match(/(?:^|\r?\n)## ([a-z0-9_]+)\r?\n\s*$/u);
    if (!heading) fail('report_section_missing');
    const section = heading[1];
    if (sections.has(section)) fail('report_section_duplicate', { section });
    sections.add(section);
    return { content: entry.content, section };
  });
}

function rootAndRouter(options = {}) {
  const skillRoot = path.resolve(options.skillRoot || DEFAULT_SKILL_ROOT);
  const routerPath = options.routerPath
    ? path.resolve(path.isAbsolute(options.routerPath) ? options.routerPath : path.join(skillRoot, options.routerPath))
    : path.join(skillRoot, 'references', 'report-router.md');
  if (!inside(skillRoot, routerPath)) fail('report_router_path_invalid');
  return { skillRoot, routerPath };
}

function loadReportRouter(options = {}) {
  const { skillRoot, routerPath } = rootAndRouter(options);
  const blocks = markedBlocks(read(routerPath, 'report_router_missing'), 'router');
  if (blocks.length !== 1) fail('report_router_marker_invalid');
  return validateReportRouter(jsonPayload(blocks[0], 'report_router_json_invalid'), { skillRoot });
}

function resolveReportFile(skillRoot, routerPath, relative) {
  const file = path.resolve(path.dirname(routerPath), ...relative.split('/'));
  if (!inside(skillRoot, file)) fail('report_md_path_invalid', { path: relative });
  return file;
}

function loadReportMd(options = {}) {
  const { skillRoot, routerPath } = rootAndRouter(options);
  const router = loadReportRouter({ skillRoot, routerPath }); const specs = {}; const specLocations = {}; const loadedFiles = new Set();
  for (const report of router.reports) {
    const file = resolveReportFile(skillRoot, routerPath, report.md);
    if (loadedFiles.has(file)) continue;
    loadedFiles.add(file);
    for (const block of reportSpecSections(read(file, 'report_md_missing'))) {
      const spec = validateReportSpec(jsonPayload(block.content, 'report_spec_json_invalid'), { skillRoot });
      if (Object.hasOwn(specs, spec.report_id)) fail('report_spec_duplicate', { report_id: spec.report_id });
      specs[spec.report_id] = spec; specLocations[spec.report_id] = { file, section: block.section };
    }
  }
  const known = new Set(router.reports.map((report) => report.report_id));
  for (const reportId of Object.keys(specs)) if (!known.has(reportId)) fail('report_spec_unknown_report', { report_id: reportId });
  for (const report of router.reports) {
    const expectedFile = resolveReportFile(skillRoot, routerPath, report.md);
    const sectionSpec = Object.entries(specLocations).find(([, value]) => value.file === expectedFile && value.section === report.section);
    if (!sectionSpec) fail('report_section_missing', { report_id: report.report_id, section: report.section });
    if (sectionSpec[0] !== report.report_id) fail('report_section_report_mismatch', { report_id: report.report_id, section: report.section });
    if (specLocations[report.report_id].file !== expectedFile) fail('report_spec_file_mismatch', { report_id: report.report_id });
  }
  return { skill_root: skillRoot, router_path: routerPath, router, specs };
}

function resolveReportIds(alias, loaded) {
  const router = loaded?.router || loaded;
  if (!router?.reports || !router?.scopes) fail('report_router_invalid');
  const normalized = normalizedAlias(alias); if (!normalized) fail('report_alias_unknown');
  for (const report of router.reports) if (report.aliases.some((value) => normalizedAlias(value) === normalized)) return [report.report_id];
  for (const scope of router.scopes) if (scope.aliases.some((value) => normalizedAlias(value) === normalized)) return [...scope.report_ids];
  fail('report_alias_unknown', { alias });
}

module.exports = {
  DEFAULT_SKILL_ROOT,
  MARKERS,
  loadReportMd,
  loadReportRouter,
  markedBlocks,
  reportSpecSections,
  resolveReportIds,
};
