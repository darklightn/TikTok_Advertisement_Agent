'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { validateReportSpec } = require('../scripts/common/md-spec-validator');
const { renderOutputPath } = require('../scripts/common/output-path');
const { publishGeneratedXlsx, publishOfficialDownload } = require('../scripts/common/output-publish');
const { readFirstWorksheet, readZipEntries } = require('../scripts/common/xlsx_first_sheet');
const { writeWorkbook, zip } = require('../scripts/common/xlsx_writer');

function validatedSpec(base, overrides = {}) {
  const skillRoot = path.join(base, 'skill');
  const runner = 'scripts/routes/cross_border/fixture_report.js';
  fs.mkdirSync(path.join(skillRoot, 'scripts', 'routes', 'cross_border'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, ...runner.split('/')), "'use strict';\n");
  return validateReportSpec({
    schema_version: 'report_spec_v1', report_id: 'fixture_report', source_type: 'official_api',
    enabled: true, explicit_only: false, owner_scope: 'shop', required_variables: ['shop'],
    success_output_type: 'generated_xlsx', no_data_output_type: 'generated_xlsx',
    no_data_rule: 'trusted_zero', headers: ['ID', '名称'], required_key_columns: ['ID'],
    time_semantics: 'current_snapshot', output_granularity: 'snapshot',
    providers: { cross_border: { runner } },
    output_path_template: '店铺数据/库存/{{time_file}}',
    ...overrides,
  }, { skillRoot });
}

function context(base, overrides = {}) {
  return {
    spec: validatedSpec(base), sourceFile: path.join(base, 'source.xlsx'), shopRoot: path.join(base, 'shop'), taskId: 'task-001',
    variables: { logical_table: '库存:表', time_file: '库存.xlsx' },
    ...overrides,
  };
}

function advertiserOfficialSpec(base, overrides = {}) {
  return validatedSpec(base, {
    owner_scope: 'advertiser', required_variables: ['shop', 'advertiser'], source_type: 'official_download',
    success_output_type: 'official_xlsx', no_data_output_type: 'generated_xlsx',
    official_validation: { kind: 'fixture' }, headers: ['ID', '名称'], required_key_columns: ['ID'],
    output_path_template: '广告户数据/库存/{{time_file}}',
    ...overrides,
  });
}

function campaignOfficialSpec(base, overrides = {}) {
  return validatedSpec(base, {
    owner_scope: 'campaign',
    required_variables: ['shop', 'advertiser', 'campaign', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit', source_type: 'official_download',
    success_output_type: 'official_xlsx', no_data_output_type: 'generated_xlsx',
    time_semantics: 'requested_range', output_granularity: 'request_range',
    official_validation: { kind: 'fixture' }, headers: ['ID', '名称'], required_key_columns: ['ID'],
    output_path_template: '计划数据/报表/{{time_file}}',
    ...overrides,
  });
}

function productOfficialSpec(base, overrides = {}) {
  return validatedSpec(base, {
    owner_scope: 'product',
    required_variables: ['shop', 'advertiser', 'campaign', 'product', 'start_date', 'end_date'],
    campaign_selection: 'all_or_explicit', product_selection: 'all_or_explicit', source_type: 'official_download',
    success_output_type: 'official_xlsx', no_data_output_type: 'generated_xlsx',
    time_semantics: 'metric_date', output_granularity: 'metric_date',
    official_validation: { kind: 'fixture' }, headers: ['ID', '名称'], required_key_columns: ['ID'],
    output_path_template: '计划数据/报表/{{time_file}}',
    ...overrides,
  });
}

function temporaryFiles(destination) {
  const directory = path.dirname(destination);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.includes('.tmp.xlsx'));
}

function addSecondSheet(file) {
  const entries = readZipEntries(fs.readFileSync(file));
  const workbook = entries.get('xl/workbook.xml').toString('utf8').replace('</sheets>', '<sheet name="额外" sheetId="2" r:id="rId3"/></sheets>');
  const relationships = entries.get('xl/_rels/workbook.xml.rels').toString('utf8').replace('</Relationships>', '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>');
  const contentTypes = entries.get('[Content_Types].xml').toString('utf8').replace('</Types>', '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  entries.set('xl/workbook.xml', workbook);
  entries.set('xl/_rels/workbook.xml.rels', relationships);
  entries.set('[Content_Types].xml', contentTypes);
  entries.set('xl/worksheets/sheet2.xml', entries.get('xl/worksheets/sheet1.xml'));
  fs.writeFileSync(file, zip([...entries]));
}

function linkDirectory(t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    t.diagnostic(`physical link fixture: ${process.platform === 'win32' ? 'junction' : 'symlink'}`);
    return undefined;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
    t.diagnostic(`physical link fixture: injected lstat (${error.code})`);
    const resolvedLink = path.resolve(link);
    return {
      lstatSync(candidate) {
        if (path.resolve(candidate) === resolvedLink) {
          return { isSymbolicLink: () => true, isDirectory: () => false };
        }
        return fs.lstatSync(candidate);
      },
      realpathSync: fs.realpathSync,
    };
  }
}

test('renders the five-level path and rejects reserved, deep, and escaping templates', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'output-path-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base);
  assert.equal(renderOutputPath(options.spec, options.shopRoot, options.variables), path.join(options.shopRoot, '店铺数据', '库存', '库存.xlsx'));
  assert.throws(() => renderOutputPath(options.spec, options.shopRoot, { ...options.variables, time_file:'CON' }), { code:'output_path_segment_invalid' });
  assert.throws(() => renderOutputPath({ ...options.spec, output_path_template:'店铺数据/库存/额外/{{time_file}}' }, options.shopRoot, options.variables), { code:'output_path_template_invalid' });
  assert.throws(() => renderOutputPath({ ...options.spec, output_path_template: 'CON/{{time_file}}' }, options.shopRoot, options.variables), { code: 'output_path_template_invalid' });
  assert.throws(() => renderOutputPath({ ...options.spec, output_path_template: '../outside/{{time_file}}' }, options.shopRoot, options.variables), { code: 'output_path_template_invalid' });
  assert.throws(() => renderOutputPath(options.spec, options.shopRoot, { ...options.variables, time_file: '' }), { code: 'output_path_variable_missing' });
  const longFile = `${'长商品名'.repeat(35)}__2026-08-26.xlsx`;
  assert.equal(path.basename(renderOutputPath(options.spec, options.shopRoot, { ...options.variables, time_file: longFile })), longFile);
});

test('all owner scopes render exactly data ownership, report type, and file', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-owner-paths-')); t.after(() => fs.rmSync(base, { recursive:true, force:true }));
  const shopRoot = path.join(base, 'shop');
  assert.equal(renderOutputPath(advertiserOfficialSpec(base), shopRoot, { time_file:'广告户__2026-08-20.xlsx' }), path.join(shopRoot, '广告户数据', '库存', '广告户__2026-08-20.xlsx'));
  assert.equal(renderOutputPath(campaignOfficialSpec(base), shopRoot, { time_file:'计划__2026-08-01_至_2026-08-31.xlsx' }), path.join(shopRoot, '计划数据', '报表', '计划__2026-08-01_至_2026-08-31.xlsx'));
  assert.equal(renderOutputPath(productOfficialSpec(base), shopRoot, { time_file:'计划__商品__2026-08-01.xlsx' }), path.join(shopRoot, '计划数据', '报表', '计划__商品__2026-08-01.xlsx'));
});
test('atomically replaces a generated XLSX and returns its final path row count and hash', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'output-success-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base); writeWorkbook(options.sourceFile, [options.spec.headers, ['1', '商品'], ['', '说明'], ['2', '另一商品']]);
  const destination = renderOutputPath(options.spec, options.shopRoot, options.variables); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old');
  const result = publishGeneratedXlsx(options);
  assert.equal(result.status, 'success'); assert.equal(result.output_file, destination); assert.equal(result.data_row_count, 2);
  assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex'));
  assert.notEqual(fs.readFileSync(destination, 'utf8'), 'old'); assert.deepEqual(temporaryFiles(destination), []);
});

test('publishes only a trusted eligible zero-row workbook as no_data', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'output-empty-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base, { trustedZero: true }); writeWorkbook(options.sourceFile, [options.spec.headers]);
  const destination = renderOutputPath(options.spec, options.shopRoot, options.variables); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old');
  const result = publishGeneratedXlsx(options);
  assert.equal(result.status, 'no_data'); assert.equal(result.data_row_count, 0); assert.equal(result.output_file, destination);
  assert.deepEqual(temporaryFiles(destination), []);
});

test('publishes generated trusted-zero XLSX for an official-download spec without rewriting the spec', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'official-generated-zero-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const spec = advertiserOfficialSpec(base); const sourceFile = path.join(base, 'empty.xlsx');
  const shopRoot = path.join(base, 'shop'); const variables = { advertiser_name: '广告户', advertiser_id: '22001', time_file: '当前快照.xlsx' };
  writeWorkbook(sourceFile, [spec.headers]);
  const destination = renderOutputPath(spec, shopRoot, variables); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old');
  const result = publishGeneratedXlsx({ spec, sourceFile, shopRoot, variables, trustedZero: true, taskId: 'task-zero' });
  assert.equal(result.status, 'no_data'); assert.equal(result.data_row_count, 0); assert.equal(result.output_file, destination);
  assert.notEqual(fs.readFileSync(destination, 'utf8'), 'old');

  fs.writeFileSync(destination, 'old-again');
  assert.equal(publishGeneratedXlsx({ spec, sourceFile, shopRoot, variables, trustedZero: false, taskId: 'task-false' }).reason_code, 'zero_data_not_trusted');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old-again');
  writeWorkbook(sourceFile, [spec.headers, ['1', '业务行']]);
  assert.equal(publishGeneratedXlsx({
    spec, sourceFile, shopRoot, variables, trustedZero: true, expectedStatus: 'no_data', taskId: 'task-status',
  }).reason_code, 'status_row_count_mismatch');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old-again');
  writeWorkbook(sourceFile, [['错误', '表头']]);
  assert.equal(publishGeneratedXlsx({ spec, sourceFile, shopRoot, variables, trustedZero: true, taskId: 'task-bad' }).reason_code, 'xlsx_headers_mismatch');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old-again');
});

test('generated publisher rejects linked shop-root and report parents without external writes', (t) => {
  for (const level of ['shop_root', 'report_parent']) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `generated-link-${level}-`)); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const options = context(base); writeWorkbook(options.sourceFile, [options.spec.headers, ['1', '商品']]);
    const external = path.join(base, 'external'); fs.mkdirSync(external);
    let link; let externalFormal;
    if (level === 'shop_root') {
      link = options.shopRoot;
      externalFormal = path.join(external, '店铺数据', '库存', '库存.xlsx');
    } else {
      const reportRoot = path.join(options.shopRoot, '店铺数据'); fs.mkdirSync(reportRoot, { recursive: true });
      link = path.join(reportRoot, '库存'); externalFormal = path.join(external, '库存.xlsx');
    }
    fs.mkdirSync(path.dirname(externalFormal), { recursive: true }); fs.writeFileSync(externalFormal, 'outside-old');
    const physicalFs = linkDirectory(t, external, link);
    const result = publishGeneratedXlsx({ ...options, physicalFs });
    assert.equal(result.reason_code, 'output_path_link_unsupported');
    assert.equal(fs.readFileSync(externalFormal, 'utf8'), 'outside-old');
    assert.deepEqual(fs.readdirSync(path.dirname(externalFormal)), [path.basename(externalFormal)]);
  }
});

test('official publisher rejects a linked report directory without replacing the external formal file', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'official-link-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const spec = advertiserOfficialSpec(base); const sourceFile = path.join(base, 'source.xlsx'); writeWorkbook(sourceFile, [['official']]);
  const shopRoot = path.join(base, 'shop'); const parent = path.join(shopRoot, '广告户数据'); fs.mkdirSync(parent, { recursive: true });
  const external = path.join(base, 'external'); const externalFormal = path.join(external, '当前快照.xlsx');
  fs.mkdirSync(path.dirname(externalFormal), { recursive: true }); fs.writeFileSync(externalFormal, 'outside-old');
  const link = path.join(parent, '库存'); const physicalFs = linkDirectory(t, external, link);
  const options = {
    spec, sourceFile, expectedSha256: crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'),
    status: 'success', dataRowCount: 1, shopRoot, taskId: 'task-link', physicalFs,
    variables: { time_file: '当前快照.xlsx' },
  };
  assert.equal(publishOfficialDownload({ ...options, expectedSha256: '0'.repeat(64) }).reason_code, 'source_hash_mismatch');
  const result = publishOfficialDownload(options);
  assert.equal(result.reason_code, 'output_path_link_unsupported');
  assert.equal(fs.readFileSync(externalFormal, 'utf8'), 'outside-old');
  assert.deepEqual(fs.readdirSync(path.dirname(externalFormal)), [path.basename(externalFormal)]);
});

test('official XLSX publication can append a frozen product identity without changing the downloaded source', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'official-product-id-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const spec = advertiserOfficialSpec(base); const sourceFile = path.join(base, 'source.xlsx');
  writeWorkbook(sourceFile, [['Post ID', 'Cost'], ['post-1', 12], ['post-2', 8]]);
  const source = fs.readFileSync(sourceFile); const options = {
    spec, sourceFile, expectedSha256: crypto.createHash('sha256').update(source).digest('hex'),
    status: 'success', dataRowCount: 2, shopRoot: path.join(base, 'shop'), taskId: 'task-product-id',
    variables: { time_file: '当前快照.xlsx' }, xlsxColumns: { product_id: '1735820935607387499' },
  };
  const result = publishOfficialDownload(options); assert.equal(result.status, 'success');
  assert.deepEqual(fs.readFileSync(sourceFile), source);
  const sheet = readFirstWorksheet(fs.readFileSync(result.output_file)); const index = sheet.headers.indexOf('product_id');
  assert.ok(index >= 0); assert.deepEqual(sheet.rows.slice(1).map((row) => row[index]), ['1735820935607387499', '1735820935607387499']);
  assert.notEqual(result.sha256, options.expectedSha256);
});

test('post-mkdir physical recheck rejects a parent replaced by a link before copy', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'post-mkdir-link-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base); writeWorkbook(options.sourceFile, [options.spec.headers, ['1', '商品']]);
  const destination = renderOutputPath(options.spec, options.shopRoot, options.variables);
  const replacedParent = path.resolve(path.dirname(destination));
  const physicalFs = {
    lstatSync(candidate) {
      if (path.resolve(candidate) === replacedParent && fs.existsSync(candidate)) {
        return { isSymbolicLink: () => true, isDirectory: () => false };
      }
      return fs.lstatSync(candidate);
    },
    realpathSync: fs.realpathSync,
  };
  const result = publishGeneratedXlsx({ ...options, physicalFs });
  assert.equal(result.reason_code, 'output_path_link_unsupported');
  assert.equal(fs.existsSync(destination), false); assert.deepEqual(temporaryFiles(destination), []);

  const escapeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'post-mkdir-realpath-')); t.after(() => fs.rmSync(escapeBase, { recursive: true, force: true }));
  const escapeOptions = context(escapeBase); writeWorkbook(escapeOptions.sourceFile, [escapeOptions.spec.headers, ['1', '商品']]);
  const escapeDestination = renderOutputPath(escapeOptions.spec, escapeOptions.shopRoot, escapeOptions.variables);
  const escapeParent = path.resolve(path.dirname(escapeDestination)); const external = path.join(escapeBase, 'external'); fs.mkdirSync(external);
  const physicalEscapeFs = {
    lstatSync: fs.lstatSync,
    realpathSync(candidate) {
      return path.resolve(candidate) === escapeParent ? external : fs.realpathSync(candidate);
    },
  };
  const escaped = publishGeneratedXlsx({ ...escapeOptions, physicalFs: physicalEscapeFs });
  assert.equal(escaped.reason_code, 'output_path_physical_escape');
  assert.equal(fs.existsSync(escapeDestination), false); assert.deepEqual(fs.readdirSync(external), []);
});

test('rejects untrusted not-applicable and key-empty zero rows without formal output', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'output-zero-reject-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base); writeWorkbook(options.sourceFile, [options.spec.headers, ['', '说明']]);
  assert.equal(publishGeneratedXlsx(options).reason_code, 'zero_data_not_trusted');
  assert.equal(publishGeneratedXlsx({ ...options, spec: validatedSpec(base, { no_data_rule: 'not_applicable', no_data_output_type: null }), trustedZero: true }).reason_code, 'no_data_not_applicable');
  assert.equal(publishGeneratedXlsx({ ...options, spec: { ...options.spec, no_data_output_type: 'official_xlsx' }, trustedZero: true }).reason_code, 'unsupported_output_type');
  const destination = renderOutputPath(options.spec, options.shopRoot, options.variables);
  assert.equal(fs.existsSync(options.shopRoot), false); assert.equal(fs.existsSync(destination), false); assert.deepEqual(temporaryFiles(destination), []);
});

test('rejects wrong headers missing sources and unsupported output families', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'output-invalid-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base); writeWorkbook(options.sourceFile, [['名称', 'ID'], ['商品', '1']]);
  assert.equal(publishGeneratedXlsx(options).reason_code, 'xlsx_headers_mismatch');
  assert.equal(fs.existsSync(options.shopRoot), false);
  const destination = renderOutputPath(options.spec, options.shopRoot, options.variables);
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old');
  assert.equal(publishGeneratedXlsx(options).reason_code, 'xlsx_headers_mismatch'); assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
  assert.equal(publishGeneratedXlsx({ ...options, sourceFile: path.join(base, 'missing.xlsx') }).reason_code, 'source_file_missing');
  assert.equal(publishGeneratedXlsx({ ...options, spec: validatedSpec(base, { success_output_type: 'generated_csv', no_data_output_type: 'generated_csv' }) }).reason_code, 'unsupported_output_type');
  assert.equal(publishGeneratedXlsx({ ...options, spec: validatedSpec(base, {
    source_type: 'official_download', success_output_type: 'official_xlsx', no_data_output_type: null,
    no_data_rule: 'not_applicable', official_validation: { kind: 'fixture' },
  }) }).reason_code, 'unsupported_output_type');
});

test('rejects a readable workbook containing more than one sheet', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'output-multi-sheet-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base); writeWorkbook(options.sourceFile, [options.spec.headers, ['1', '商品']]); addSecondSheet(options.sourceFile);
  assert.equal(publishGeneratedXlsx(options).reason_code, 'xlsx_sheet_count_invalid');
});

test('replace failure keeps the old file and cleans only this task temporary sibling', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'output-replace-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const options = context(base); writeWorkbook(options.sourceFile, [options.spec.headers, ['1', '商品']]);
  const destination = renderOutputPath(options.spec, options.shopRoot, options.variables); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'old');
  const result = publishGeneratedXlsx({ ...options, replaceFile: () => { throw new Error('injected'); } });
  assert.deepEqual(result, { status: 'failed', reason_code: 'output_replace_failed' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old'); assert.deepEqual(temporaryFiles(destination), []);
  const noOp = publishGeneratedXlsx({ ...options, replaceFile: () => {} });
  assert.equal(noOp.reason_code, 'published_hash_mismatch');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old'); assert.deepEqual(temporaryFiles(destination), []);
});
