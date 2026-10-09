'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultPipelineConfigPath, loadPipelineRuntimeConfig } = require('../scripts/common/pipeline_runtime_config');

const contract = require('../config/pipeline-runtime-config-contract-v1.json');

test('runtime parser is bound to the checked-in machine contract', () => {
  assert.equal(contract.contract_id, 'pipeline_runtime_config_contract');
  assert.equal(contract.schema_version, 'tiktok_shop_data_pipeline_runtime_v2');
  assert.equal(contract.environment_override, 'TIKTOK_SHOP_DATA_PIPELINE_CONFIG');
  assert.deepEqual(contract.required_fields, ['schema_version', 'data_department_root']);
  assert.equal(contract.path_rules.legacy_fallback_forbidden, true);
  assert.equal(contract.path_rules.legacy_root_fields_forbidden, true);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeConfig(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }

test('loads one department root and derives export cleaning and business roots', (t) => {
  const root = fixture(t); const file = path.join(root, '共享配置', 'config.json');
  const departmentRoot = path.join(root, '广告数据部');
  writeConfig(file, { schema_version: 'tiktok_shop_data_pipeline_runtime_v2', data_department_root: departmentRoot });
  assert.deepEqual(loadPipelineRuntimeConfig({ configPath: file }), {
    schema_version: 'tiktok_shop_data_pipeline_runtime_v2',
    data_department_root: path.resolve(departmentRoot),
    export_data_root: path.resolve(departmentRoot, '99_全局生成记录_不用看', '导出运行'),
    cleaning_data_root: path.resolve(departmentRoot, '99_全局生成记录_不用看', '清洗运行'),
    business_view_root: path.resolve(departmentRoot),
    config_path: path.resolve(file),
  });
});

test('environment override selects the shared config file', (t) => {
  const root = fixture(t); const file = path.join(root, 'custom.json');
  writeConfig(file, { schema_version: 'tiktok_shop_data_pipeline_runtime_v2', data_department_root: path.join(root, 'department') });
  const env = { LOCALAPPDATA: path.join(root, 'local'), TIKTOK_SHOP_DATA_PIPELINE_CONFIG: file };
  assert.equal(defaultPipelineConfigPath(env), path.resolve(file));
  assert.equal(loadPipelineRuntimeConfig({ env }).config_path, path.resolve(file));
});

test('missing relative system repository and legacy roots fail closed', (t) => {
  const root = fixture(t); const file = path.join(root, 'config.json');
  assert.throws(() => loadPipelineRuntimeConfig({ configPath: file }), { code: 'pipeline_runtime_config_missing' });
  writeConfig(file, { schema_version: 'tiktok_shop_data_pipeline_runtime_v2', data_department_root: 'relative' });
  assert.throws(() => loadPipelineRuntimeConfig({ configPath: file }), { code: 'pipeline_data_root_invalid' });
  writeConfig(file, { schema_version: 'tiktok_shop_data_pipeline_runtime_v1', export_data_root: path.join(root, 'export'), cleaning_data_root: path.join(root, 'clean') });
  assert.throws(() => loadPipelineRuntimeConfig({ configPath: file }), { code: 'pipeline_runtime_config_invalid' });
  const env = { WINDIR: path.join(root, 'Windows') };
  writeConfig(file, { schema_version: 'tiktok_shop_data_pipeline_runtime_v2', data_department_root: path.join(env.WINDIR, 'data') });
  assert.throws(() => loadPipelineRuntimeConfig({ configPath: file, env }), { code: 'pipeline_data_root_forbidden' });
  const repository = path.join(root, 'repository'); fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  writeConfig(file, { schema_version: 'tiktok_shop_data_pipeline_runtime_v2', data_department_root: path.join(repository, 'runtime') });
  assert.throws(() => loadPipelineRuntimeConfig({ configPath: file }), { code: 'pipeline_data_root_forbidden' });
});
