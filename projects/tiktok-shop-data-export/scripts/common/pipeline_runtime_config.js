'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 'tiktok_shop_data_pipeline_runtime_v2';
const GLOBAL_RECORDS_DIRECTORY = '99_全局生成记录_不用看';

function fail(code, details = {}) { throw Object.assign(new Error(code), { code, details }); }

function defaultPipelineConfigPath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.resolve(env.TIKTOK_SHOP_DATA_PIPELINE_CONFIG || path.join(base, 'tiktok-shop-data-pipeline', 'config.json'));
}

function normalizeDataRoot(value, field, env = process.env) {
  const raw = String(value || '').trim();
  if (!raw || !path.isAbsolute(raw)) fail('pipeline_data_root_invalid', { field });
  const root = path.resolve(raw);
  if (root === path.parse(root).root) fail('pipeline_data_root_invalid', { field });
  const blocked = [env.WINDIR, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((item) => path.resolve(item).toLowerCase());
  if (blocked.some((item) => root.toLowerCase() === item || root.toLowerCase().startsWith(`${item}${path.sep}`))) fail('pipeline_data_root_forbidden', { field });
  for (let current = root; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) fail('pipeline_data_root_forbidden', { field });
    if (current === path.dirname(current)) break;
  }
  return root;
}

function loadPipelineRuntimeConfig(options = {}) {
  const env = options.env || process.env;
  const file = path.resolve(options.configPath || defaultPipelineConfigPath(env));
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail('pipeline_runtime_config_missing', { config_path: file });
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('pipeline_runtime_config_invalid', { config_path: file }); }
  if (value?.schema_version !== SCHEMA_VERSION) fail('pipeline_runtime_config_invalid', { config_path: file });
  if ('export_data_root' in value || 'cleaning_data_root' in value) fail('pipeline_runtime_config_invalid', { config_path: file });
  const dataDepartmentRoot = normalizeDataRoot(value.data_department_root, 'data_department_root', env);
  const recordsRoot = path.join(dataDepartmentRoot, GLOBAL_RECORDS_DIRECTORY);
  return {
    schema_version: SCHEMA_VERSION,
    data_department_root: dataDepartmentRoot,
    export_data_root: path.join(recordsRoot, '导出运行'),
    cleaning_data_root: path.join(recordsRoot, '清洗运行'),
    business_view_root: dataDepartmentRoot,
    config_path: file,
  };
}

module.exports = { SCHEMA_VERSION, defaultPipelineConfigPath, loadPipelineRuntimeConfig, normalizeDataRoot };
