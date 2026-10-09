#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isSellerUrl } = require('./b_attach_shop');
const { safeSegment, sha256File } = require('./common/file-check');
const { validateCsvTable } = require('./common/csv');
const { validateCurrencyEvidence } = require('./common/currency-contract');
const { embedCurrency } = require('./common/currency-embed');
const { ensureManualCostTable, manualCostTablePath } = require('./common/manual-cost-table');
const { inside } = require('./common/md-spec-validator');
const { renderOutputPath } = require('./common/output-path');
const { publishGeneratedCsv, publishGeneratedXlsx, publishOfficialDownload } = require('./common/output-publish');
const { createRunSession, parseRunRequest } = require('./common/run-context');
const { loadReportMd } = require('./load-report-md');

const REQUEST_FIELDS = new Set(['shop', 'report_scopes', 'start_date', 'end_date', 'advertiser', 'campaign', 'product']);
const FATAL_REASONS = new Set([
  'browser_disconnected', 'browser_context_missing', 'browser_context_changed',
  'seller_login_page', 'seller_origin_invalid', 'seller_origin_mismatch', 'seller_page_missing',
  'result_shop_identity_mismatch', 'result_advertiser_identity_mismatch', 'result_campaign_identity_mismatch',
  'advertiser_output_identity_missing', 'campaign_output_identity_missing',
  'product_output_identity_missing', 'advertiser_directory_identity_ambiguous',
  'campaign_directory_identity_ambiguous', 'product_directory_identity_ambiguous',
  'unsupported_provider', 'provider_binding_invalid',
  'transport_login_required',
]);

function codedError(code) { return Object.assign(new Error(code), { code }); }
function reason(error, fallback = 'report_execution_failed') { return error?.code || fallback; }
function safeFailureDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['task_id','attempts','elapsed_ms','candidate_count','exact_match_count','task_observed','last_status','url_present','outcome',
    'tab_id','page_number','origin','path','error_category','error_name','http_status','business_code','stage','requested_date',
    'field_path','failure_kind','item_index','expected_digest','actual_digest','actual_present','actual_type',
    'offset','total','card_count','unique_count','expected_total','actual_total'];
  const result = {};
  for (const key of allowed) if (['string','number','boolean'].includes(typeof value[key]) || value[key] === null) result[key] = value[key];
  if (value.status_counts && typeof value.status_counts === 'object' && !Array.isArray(value.status_counts)) {
    result.status_counts = Object.fromEntries(Object.entries(value.status_counts).filter(([key,count]) => /^[A-Za-z0-9_<>=-]+$/u.test(key) && Number.isInteger(count) && count >= 0));
  }
  return Object.keys(result).length ? result : null;
}
function failedReport(reportId, reasonCode, diagnostics = null) {
  const safeDiagnostics = safeFailureDiagnostics(diagnostics);
  return { report_id: reportId, status: 'failed', files: [], data_row_count: 0, reason_code: reasonCode,
    ...(safeDiagnostics ? { diagnostics:safeDiagnostics } : {}) };
}
function failedResult(reasonCode, parsed = null, context = null) {
  const reportIds = parsed?.report_ids ? [...parsed.report_ids] : [];
  return {
    schema_version: 'export_result_v1', request_id: context?.request_id || null, status: 'failed',
    shop_id: context?.shop_id || null, report_ids: reportIds,
    reports: reportIds.map((reportId) => failedReport(reportId, reasonCode)),
    reason_code: reasonCode,
  };
}

function validateRequestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !REQUEST_FIELDS.has(key))) throw codedError('run_request_invalid');
}

function runnerPath(skillRoot, relativePath) {
  const absolute = path.resolve(skillRoot, ...String(relativePath || '').split('/'));
  if (!inside(skillRoot, absolute)) throw codedError('report_runner_invalid');
  return absolute;
}

function selectProvider(spec, providerId) {
  if (!/^[a-z0-9_]+$/u.test(String(providerId || ''))) throw codedError('unsupported_provider');
  const provider = spec?.providers?.[providerId];
  if (!provider) throw codedError('report_provider_unsupported');
  return provider;
}

function loadProviderRunner(skillRoot, spec, provider, requireModule = require) {
  let module;
  try { module = requireModule(runnerPath(skillRoot, provider.runner)); }
  catch (error) {
    if (error?.code === 'report_runner_invalid') throw error;
    throw codedError('report_runner_load_failed');
  }
  if (typeof module?.run !== 'function') throw codedError('report_runner_abi_invalid');
  if (module.validateSpec !== undefined) {
    if (typeof module.validateSpec !== 'function') throw codedError('report_runner_abi_invalid');
    module.validateSpec(spec, provider);
  }
  return module.run;
}

function pageOrigin(page) {
  try { return new URL(page.url()).origin; } catch { return ''; }
}

function assertSessionAlive(session) {
  const { browser, browserContext, runContext } = session;
  if (typeof browser?.isConnected !== 'function' || !browser.isConnected()) throw codedError('browser_disconnected');
  const contexts = typeof browser.contexts === 'function' ? browser.contexts() : [];
  if (!browserContext || !contexts.includes(browserContext) || typeof browserContext.pages !== 'function') {
    throw codedError(contexts.length ? 'browser_context_changed' : 'browser_context_missing');
  }
  let origin;
  try { origin = new URL(runContext.b?.seller_page_url).origin; } catch { throw codedError('seller_origin_invalid'); }
  const pages = browserContext.pages();
  const sameOrigin = pages.filter((page) => pageOrigin(page) === origin);
  if (sameOrigin.some((page) => isSellerUrl(page.url()))) return;
  if (sameOrigin.length) throw codedError('seller_login_page');
  throw codedError('seller_page_missing');
}

function assertRunContextBinding(context, parsed) {
  const sameReports = JSON.stringify(context?.report_ids) === JSON.stringify(parsed.report_ids);
  const sameCampaignRef = (context?.campaign_ref ?? null) === (parsed.campaign_ref ?? null);
  const sameProductRef = (context?.product_ref ?? null) === (parsed.product_ref ?? null);
  const sellerId = String(context?.seller_id || '');
  const sameShopIdentity = /^\d+$/u.test(sellerId) && String(context.shop_id || '') === sellerId
    && String(context.shop?.seller_id || '') === sellerId
    && ['shop_code', 'seller_type', 'business_type', 'shop_region', 'region_code', 'seller_hostname', 'shop_type']
      .every((field) => context[field] === context.shop?.[field]);
  const sameBinding = context?.a?.shop_alias === context?.b?.requested_shop_alias
    && context.a.shop_alias === context?.shop?.shop_alias
    && String(context.a.browser_id || '') === String(context.b.browser_id || '')
    && String(context.a.browser_id || '') === String(context.shop.browser_id || '')
    && context.a.cdp_url === context.b.cdp_url && context.a.cdp_url === context.shop.cdp_url
    && context.shop.provider_id === context.provider_id;
  if (!sameReports || !sameCampaignRef || !sameProductRef || !sameShopIdentity || !sameBinding) {
    throw codedError('provider_binding_invalid');
  }
}

function isFatalReason(reasonCode) {
  return FATAL_REASONS.has(reasonCode)
    || /(?:^|_)(?:identity_mismatch|identity_unavailable|cdp_disconnected)$/u.test(reasonCode);
}

function outputExtension(spec, status) {
  const type = status === 'no_data' ? spec.no_data_output_type : spec.success_output_type;
  return type?.endsWith('_csv') ? '.csv' : '.xlsx';
}

function scopedOutputFile(spec, identity, baseFile) {
  const extension = path.extname(baseFile);
  const stem = path.basename(baseFile, extension);
  const parts = [];
  if (spec.owner_scope === 'advertiser') parts.push(identity.advertiser_name);
  if (spec.owner_scope === 'campaign' || spec.owner_scope === 'product') parts.push(identity.campaign_name);
  if (spec.owner_scope === 'product') {
    parts.push(identity.product_name);
    parts.push(crypto.createHash('sha256').update(String(identity.product_id)).digest('hex').slice(0, 8));
  }
  if (identity.logical_table) parts.push(identity.logical_table);
  parts.push(stem);
  const file = `${parts.map((part) => safeSegment(part)).join('__')}${extension}`;
  if (file.length > 180) throw codedError('output_file_name_too_long');
  return file;
}

function outputVariables(spec, context, artifact = null, status = 'success') {
  const identity = { shop_name: context.shop_name, shop_id: context.shop_id };
  if (artifact?.logical_table !== undefined) {
    const logicalTable = String(artifact.logical_table);
    if (!/^[a-z0-9_]+$/u.test(logicalTable)) throw codedError('logical_table_output_invalid');
    const table = Array.isArray(spec.logical_tables)
      ? spec.logical_tables.find((item) => item.logical_table === logicalTable)
      : null;
    if (Array.isArray(spec.logical_tables) && !table) throw codedError('logical_table_output_invalid');
    identity.logical_table = table?.output_directory || logicalTable;
  }
  if (['advertiser', 'campaign', 'product'].includes(spec.owner_scope)) {
    if (!/^\d+$/u.test(String(context.advertiser_id || ''))
      || typeof context.advertiser_name !== 'string' || !context.advertiser_name.trim()) {
      throw codedError('advertiser_output_identity_missing');
    }
    identity.advertiser_id = context.advertiser_id;
    identity.advertiser_name = context.advertiser_name;
  }
  if (spec.owner_scope === 'campaign' || spec.owner_scope === 'product') {
    if (!/^\d+$/u.test(String(artifact?.campaign_id || ''))
      || typeof artifact?.campaign_name !== 'string' || !artifact.campaign_name.trim()) {
      throw codedError('campaign_output_identity_missing');
    }
    identity.campaign_id = String(artifact.campaign_id);
    identity.campaign_name = artifact.campaign_name;
  }
  if (spec.owner_scope === 'product') {
    if (!/^\d+$/u.test(String(artifact?.product_id || ''))
      || typeof artifact?.product_name !== 'string' || !artifact.product_name.trim()) {
      throw codedError('product_output_identity_missing');
    }
    identity.product_id = String(artifact.product_id);
    identity.product_name = artifact.product_name;
  }
  const extension = outputExtension(spec, status);
  if (spec.output_granularity === 'snapshot') {
    const collectionDate = String(context.collection_date || '');
    const parsed = new Date(`${collectionDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(collectionDate) || Number.isNaN(parsed.valueOf())
      || parsed.toISOString().slice(0, 10) !== collectionDate) throw codedError('collection_date_output_invalid');
    return { ...identity, time_file: scopedOutputFile(spec, identity, `${collectionDate}${extension}`) };
  }
  if (spec.output_granularity === 'request_range') {
    const sameDay = spec.single_day_time_file === true && context.start_date === context.end_date;
    return {
      ...identity, start_date: context.start_date, end_date: context.end_date,
      time_file: scopedOutputFile(spec, identity, sameDay
        ? `${context.start_date}${extension}`
        : `${context.start_date}_至_${context.end_date}${extension}`),
    };
  }
  if (spec.output_granularity === 'metric_date') {
    const metricDate = String(artifact?.metric_date || '');
    const parsed = new Date(`${metricDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(metricDate) || Number.isNaN(parsed.valueOf())
      || parsed.toISOString().slice(0, 10) !== metricDate) throw codedError('metric_date_output_invalid');
    return { ...identity, start_date: metricDate, end_date: metricDate, time_file: scopedOutputFile(spec, identity, `${metricDate}${extension}`) };
  }
  if (spec.output_granularity === 'source_segment') {
    const segmentFile = String(artifact?.segment_file || '');
    if (!segmentFile.endsWith(extension) || path.basename(segmentFile) !== segmentFile) throw codedError('segment_file_output_invalid');
    return {
      ...identity, start_date: context.start_date, end_date: context.end_date,
      segment_file: scopedOutputFile(spec, identity, segmentFile),
    };
  }
  throw codedError('unsupported_output_granularity');
}

function inspectRunnerIdentity(result, spec, context) {
  if (String(result.shop_id || '') !== String(context.seller_id)) throw codedError('result_shop_identity_mismatch');
  for (const field of ['seller_id', 'oec_seller_id']) {
    if (result[field] !== undefined && String(result[field]) !== String(context.seller_id)) throw codedError('result_shop_identity_mismatch');
  }
  if (result.shop_alias !== undefined && result.shop_alias !== context.shop_name) throw codedError('result_shop_identity_mismatch');
  if (result.browser_id !== undefined && String(result.browser_id) !== String(context.browser_id)) throw codedError('result_shop_identity_mismatch');
  const advertiserRequired = spec.required_variables.includes('advertiser');
  const frozenAdvertiserId = String(context.advertiser_id || '');
  const resultAdvertiserId = String(result.advertiser_id || '');
  if (advertiserRequired
    && (!/^\d+$/u.test(frozenAdvertiserId) || !/^\d+$/u.test(resultAdvertiserId)
      || resultAdvertiserId !== frozenAdvertiserId)) {
    throw codedError('result_advertiser_identity_mismatch');
  }
  if (!advertiserRequired && result.advertiser_id !== undefined && result.advertiser_id !== null
    && resultAdvertiserId !== frozenAdvertiserId) {
    throw codedError('result_advertiser_identity_mismatch');
  }
  if (result.business_center_id !== undefined
    && String(result.business_center_id || '') !== String(context.business_center_id || '')) {
    throw codedError('result_advertiser_identity_mismatch');
  }
  if (result.provider_id !== undefined && result.provider_id !== context.provider_id) throw codedError('provider_binding_invalid');
}

function buildRunnerInput(context, spec, providerSpec, outputDir) {
  const required = new Set(spec.required_variables);
  const input = {
    a: context.a, b: context.b, shop: context.shop,
    reportSpec: spec, providerSpec, outputDir,
  };
  if (required.has('start_date')) input.startDate = context.start_date;
  if (required.has('end_date')) input.endDate = context.end_date;
  if (required.has('advertiser')) {
    input.advertiserId = context.advertiser_id;
    input.advertiserName = context.advertiser_name;
    input.advertiserCurrency = context.advertiser_currency;
    input.businessCenterId = context.business_center_id;
  }
  if (required.has('campaign')) input.campaignRef = context.campaign_ref;
  if (required.has('product')) input.productRef = context.product_ref;
  return input;
}

function inspectRunnerOutput(result, spec, context, stagingDir) {
  if (!['success', 'no_data'].includes(result?.status)) throw codedError('runner_status_invalid');
  inspectRunnerIdentity(result, spec, context);
  if (spec.currency_contract !== undefined) {
    try { validateCurrencyEvidence(result.currency_evidence, spec.currency_contract); }
    catch (error) { throw codedError(error.code || 'currency_evidence_invalid'); }
  }
  const sourceFile = path.resolve(String(result.output_file || ''));
  let root; let realSource;
  try { root = fs.realpathSync(stagingDir); realSource = fs.realpathSync(sourceFile); } catch { throw codedError('runner_output_file_invalid'); }
  if (!inside(root, realSource) || realSource === root || !fs.statSync(realSource).isFile()) throw codedError('runner_output_file_invalid');
  const stat = fs.statSync(realSource);
  if (!Number.isInteger(result.byte_length) || result.byte_length !== stat.size) throw codedError('runner_byte_length_mismatch');
  if (!/^[a-f0-9]{64}$/u.test(String(result.sha256 || '')) || sha256File(realSource) !== result.sha256) {
    throw codedError('runner_hash_mismatch');
  }
  const outputType = result.status === 'success' ? spec.success_output_type : spec.no_data_output_type;
  let dataRowCount;
  if (outputType === 'generated_xlsx' || outputType === 'generated_csv') {
    if (result.generated_file !== true) throw codedError('runner_output_contract_invalid');
    dataRowCount = result.row_count;
    if (outputType === 'generated_csv') {
      let checked;
      try { checked = validateCsvTable(realSource, spec, spec.generated_csv_validation || {}); }
      catch (error) { throw codedError(error.code || 'csv_validation_failed'); }
      if (checked.data_row_count !== dataRowCount) throw codedError('runner_status_row_count_mismatch');
    }
  } else if (outputType === 'official_xlsx' || outputType === 'official_csv') {
    if (result.official_file_unchanged !== true) throw codedError('runner_output_contract_invalid');
    dataRowCount = result.data_row_count;
  } else throw codedError('unsupported_report_output');
  if (!Number.isInteger(dataRowCount) || dataRowCount < 0
    || (result.status === 'success' && dataRowCount < 1)
    || (result.status === 'no_data' && dataRowCount !== 0)) throw codedError('runner_status_row_count_mismatch');
  return { sourceFile: realSource, dataRowCount, outputType };
}

function publishRunnerOutput(result, spec, context, stagingDir, dependencies = {}) {
  const inspected = inspectRunnerOutput(result, spec, context, stagingDir);
  const variables = outputVariables(spec, context, null, result.status);
  let published;
  if (inspected.outputType === 'generated_xlsx') {
    published = (dependencies.publishGeneratedXlsx || publishGeneratedXlsx)({
      spec, sourceFile: inspected.sourceFile, shopRoot: context.shop_root, variables,
      trustedZero: result.status === 'no_data', expectedStatus: result.status, taskId: context.request_id,
    });
  } else if (inspected.outputType === 'generated_csv') {
    published = (dependencies.publishGeneratedCsv || publishGeneratedCsv)({
      spec, sourceFile: inspected.sourceFile, shopRoot: context.shop_root, variables,
      trustedZero: result.status === 'no_data', expectedStatus: result.status, taskId: context.request_id,
    });
  } else if (inspected.outputType === 'official_xlsx' || inspected.outputType === 'official_csv') {
    published = (dependencies.publishOfficialDownload || publishOfficialDownload)({
      spec, sourceFile: inspected.sourceFile, expectedSha256: result.sha256,
      status: result.status, dataRowCount: inspected.dataRowCount, noDataEvidence: result.no_data_evidence,
      shopRoot: context.shop_root, variables, taskId: context.request_id,
    });
  } else throw codedError('unsupported_report_output');
  if (published?.status === 'failed') throw codedError(published.reason_code || 'output_publish_failed');
  if (published?.status !== result.status || published.data_row_count !== inspected.dataRowCount) {
    throw codedError('publisher_result_mismatch');
  }
  if (spec.currency_contract !== undefined) {
    const embedded = (dependencies.embedCurrency || embedCurrency)({
      file: published.output_file, evidence: result.currency_evidence, taskId: `${context.request_id}-currency`,
    });
    if (embedded?.status === 'failed') throw codedError(embedded.reason_code || 'currency_embed_failed');
    if (embedded?.status !== 'success') throw codedError('currency_embed_failed');
    published.sha256 = embedded.sha256;
  }
  return {
    report_id: spec.report_id, status: published.status,
    files: [published.output_file],
    data_row_count: published.data_row_count, sha256: published.sha256,
    ...(spec.currency_contract !== undefined ? { currency_embedded: true } : {}),
  };
}

function publishedIdentityColumns(spec, artifact) {
  if (spec.published_identity_columns === undefined) return undefined;
  const columns = {};
  for (const column of spec.published_identity_columns) {
    const value = artifact?.[column];
    if (value === undefined || value === null || !String(value).trim()) throw codedError('published_identity_column_missing');
    columns[column] = String(value);
  }
  return columns;
}

function normalizedCampaignName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function aggregateArtifactStatus(artifacts) {
  if (!artifacts.length || artifacts.every((item) => item.status === 'no_data')) return 'no_data';
  const failed = artifacts.filter((item) => item.status === 'failed').length;
  const completed = artifacts.length - failed;
  if (!failed && artifacts.some((item) => item.status === 'success')) return 'success';
  if (failed && completed) return 'partial';
  return 'failed';
}

function artifactSpec(spec, artifact) {
  if (!Array.isArray(spec.logical_tables)) return spec;
  const table = spec.logical_tables.find((item) => item.logical_table === artifact.logical_table);
  if (!table) throw codedError('runner_artifact_invalid');
  return { ...spec, headers: table.headers, required_key_columns: table.required_key_columns };
}

function inspectMultiRunnerOutput(result, spec, context, stagingDir) {
  if (!['success', 'no_data', 'partial', 'failed'].includes(result?.status)
    || !Array.isArray(result.artifacts)) throw codedError('runner_status_invalid');
  inspectRunnerIdentity(result, spec, context);
  const campaignRequired = spec.required_variables.includes('campaign');
  const productRequired = spec.required_variables.includes('product');
  const explicitCampaign = campaignRequired ? context.campaign_ref ?? null : null;
  const explicitProduct = productRequired ? context.product_ref ?? null : null;
  if (!result.artifacts.length) {
    if (result.status !== 'no_data' || explicitCampaign !== null || explicitProduct !== null) {
      throw codedError('runner_status_invalid');
    }
    return [];
  }
  const hasLogicalTables = Array.isArray(spec.logical_tables);
  const seen = new Set();
  const metricDateRequired = spec.output_granularity === 'metric_date';
  const segmentRequired = spec.output_granularity === 'source_segment';
  const inspected = result.artifacts.map((artifact) => {
    if (!artifact || !['success', 'no_data', 'failed'].includes(artifact.status)
      || (hasLogicalTables && !/^[a-z0-9_]+$/u.test(String(artifact.logical_table || '')))
      || (campaignRequired && (!/^\d+$/u.test(String(artifact.campaign_id || ''))
        || typeof artifact.campaign_name !== 'string' || !artifact.campaign_name.trim()))) {
      throw codedError('runner_artifact_invalid');
    }
    const campaignId = campaignRequired ? String(artifact.campaign_id) : null;
    const campaignName = campaignRequired ? normalizedCampaignName(artifact.campaign_name) : null;
    let productId = null; let productName = null; let metricDate = null; let segmentKey = null;
    if (productRequired) {
      productId = String(artifact.product_id || ''); productName = normalizedCampaignName(artifact.product_name);
      if (!/^\d+$/u.test(productId) || !productName) throw codedError('runner_artifact_invalid');
    }
    if (metricDateRequired) {
      metricDate = String(artifact.metric_date || '');
      const parsed = new Date(`${metricDate}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(metricDate) || Number.isNaN(parsed.valueOf())
        || parsed.toISOString().slice(0, 10) !== metricDate
        || metricDate < context.start_date || metricDate > context.end_date) throw codedError('runner_artifact_invalid');
    }
    if (segmentRequired) {
      const fields = ['segment_index', 'segment_count', 'segment_start_date', 'segment_end_date', 'segment_file'];
      if (fields.some((field) => artifact[field] === undefined)
        || !Number.isInteger(artifact.segment_index) || !Number.isInteger(artifact.segment_count)
        || artifact.segment_index < 1 || artifact.segment_count < 1 || artifact.segment_index > artifact.segment_count
        || !/^\d{4}-\d{2}-\d{2}$/u.test(artifact.segment_start_date)
        || !/^\d{4}-\d{2}-\d{2}$/u.test(artifact.segment_end_date)
        || artifact.segment_start_date > artifact.segment_end_date
        || artifact.segment_start_date < context.start_date || artifact.segment_end_date > context.end_date) {
        throw codedError('runner_artifact_invalid');
      }
      segmentKey = `${artifact.segment_index}/${artifact.segment_count}/${artifact.segment_start_date}/${artifact.segment_end_date}/${artifact.segment_file}`;
    }
    const artifactKey = JSON.stringify([hasLogicalTables ? artifact.logical_table : null, campaignId, productId, metricDate, segmentKey]);
    if (seen.has(artifactKey)) throw codedError('runner_artifact_duplicate');
    seen.add(artifactKey);
    if (campaignRequired && explicitCampaign !== null) {
      const matches = /^\d+$/u.test(explicitCampaign) ? campaignId === explicitCampaign : campaignName === explicitCampaign;
      if (!matches) throw codedError('result_campaign_identity_mismatch');
    }
    if (productRequired && explicitProduct !== null) {
      const matches = /^\d+$/u.test(explicitProduct) ? productId === explicitProduct : productName === explicitProduct;
      if (!matches) throw codedError('result_product_identity_mismatch');
    }
    if (artifact.status === 'failed') {
      if (typeof artifact.reason_code !== 'string' || !artifact.reason_code
        || artifact.output_file !== undefined) throw codedError('runner_artifact_invalid');
      if (isFatalReason(artifact.reason_code)) throw codedError(artifact.reason_code);
      return { artifact, inspected: null };
    }
    const single = { ...result, ...artifact };
    delete single.artifacts;
    const resolvedSpec = artifactSpec(spec, artifact);
    return { artifact, spec: resolvedSpec, inspected: inspectRunnerOutput(single, resolvedSpec, context, stagingDir) };
  });
  if (segmentRequired) {
    const publishable = inspected.filter((item) => item.inspected).map((item) => item.artifact).sort((a, b) => a.segment_index - b.segment_index);
    const nextDay = (value) => {
      const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + 1);
      return date.toISOString().slice(0, 10);
    };
    if (publishable.length && (publishable.some((item) => item.segment_count !== publishable.length)
      || publishable.some((item, index) => item.segment_index !== index + 1)
      || publishable[0].segment_start_date !== context.start_date
      || publishable.at(-1).segment_end_date !== context.end_date
      || publishable.some((item, index) => index > 0
        && item.segment_start_date !== nextDay(publishable[index - 1].segment_end_date)))) {
      throw codedError('runner_segment_set_invalid');
    }
  }
  if (aggregateArtifactStatus(result.artifacts) !== result.status) throw codedError('runner_status_invalid');
  return inspected;
}

function publishMultiRunnerOutput(result, spec, context, stagingDir, dependencies = {}) {
  const inspected = inspectMultiRunnerOutput(result, spec, context, stagingDir);
  if (!inspected.length) {
    return { report_id: spec.report_id, status: 'no_data', files: [], data_row_count: 0, artifacts: [] };
  }
  const prepared = inspected.map((item) => {
    if (!item.inspected) return item;
    const variables = outputVariables(item.spec || spec, context, item.artifact, item.artifact.status);
    renderOutputPath(item.spec || spec, context.shop_root, variables);
    return { ...item, variables };
  });
  const artifacts = []; const files = [];
  for (const item of prepared) {
    if (!item.inspected) {
      artifacts.push({
        status: 'failed',
        ...(item.artifact.logical_table !== undefined ? { logical_table: item.artifact.logical_table } : {}),
        ...(item.artifact.campaign_id !== undefined ? {
          campaign_id: String(item.artifact.campaign_id), campaign_name: item.artifact.campaign_name,
        } : {}),
        ...(item.artifact.product_id !== undefined ? {
          product_id: String(item.artifact.product_id), product_name: item.artifact.product_name,
        } : {}),
        ...(item.artifact.metric_date !== undefined ? { metric_date: item.artifact.metric_date } : {}),
        ...(item.artifact.segment_file !== undefined ? {
          segment_index: item.artifact.segment_index, segment_count: item.artifact.segment_count,
          segment_start_date: item.artifact.segment_start_date, segment_end_date: item.artifact.segment_end_date,
          segment_file: item.artifact.segment_file,
        } : {}),
        reason_code: item.artifact.reason_code,
      });
      continue;
    }
    try {
      let published;
      if (item.inspected.outputType === 'generated_xlsx') {
        published = (dependencies.publishGeneratedXlsx || publishGeneratedXlsx)({
          spec: item.spec || spec, sourceFile: item.inspected.sourceFile, shopRoot: context.shop_root, variables: item.variables,
          trustedZero: item.artifact.status === 'no_data', expectedStatus: item.artifact.status,
          taskId: [context.request_id, item.artifact.logical_table, item.artifact.campaign_id, item.artifact.product_id, item.artifact.metric_date]
            .filter((value) => value !== undefined).join('-'),
        });
      } else if (item.inspected.outputType === 'generated_csv') {
        published = (dependencies.publishGeneratedCsv || publishGeneratedCsv)({
          spec: item.spec || spec, sourceFile: item.inspected.sourceFile, shopRoot: context.shop_root, variables: item.variables,
          trustedZero: item.artifact.status === 'no_data', expectedStatus: item.artifact.status,
          taskId: [context.request_id, item.artifact.segment_index, item.artifact.segment_count].filter((value) => value !== undefined).join('-'),
        });
      } else if (item.inspected.outputType === 'official_xlsx' || item.inspected.outputType === 'official_csv') {
        published = (dependencies.publishOfficialDownload || publishOfficialDownload)({
          spec: item.spec || spec, sourceFile: item.inspected.sourceFile, expectedSha256: item.artifact.sha256,
          status: item.artifact.status, dataRowCount: item.inspected.dataRowCount,
          noDataEvidence: item.artifact.no_data_evidence, shopRoot: context.shop_root, variables: item.variables,
          xlsxColumns: publishedIdentityColumns(item.spec || spec, item.artifact),
          taskId: [context.request_id, item.artifact.logical_table, item.artifact.campaign_id, item.artifact.product_id, item.artifact.metric_date, item.artifact.segment_index]
            .filter((value) => value !== undefined).join('-'),
        });
      } else throw codedError('unsupported_report_output');
      if (published?.status === 'failed') throw codedError(published.reason_code || 'output_publish_failed');
      if (published?.status !== item.artifact.status || published.data_row_count !== item.inspected.dataRowCount) {
        throw codedError('publisher_result_mismatch');
      }
      files.push(published.output_file);
      artifacts.push({
        status: published.status,
        ...(item.artifact.logical_table !== undefined ? { logical_table: item.artifact.logical_table } : {}),
        ...(item.artifact.campaign_id !== undefined ? {
          campaign_id: String(item.artifact.campaign_id), campaign_name: item.artifact.campaign_name,
        } : {}),
        ...(item.artifact.product_id !== undefined ? {
          product_id: String(item.artifact.product_id), product_name: item.artifact.product_name,
        } : {}),
        ...(item.artifact.metric_date !== undefined ? { metric_date: item.artifact.metric_date } : {}),
        ...(item.artifact.segment_file !== undefined ? {
          segment_index: item.artifact.segment_index, segment_count: item.artifact.segment_count,
          segment_start_date: item.artifact.segment_start_date, segment_end_date: item.artifact.segment_end_date,
          segment_file: item.artifact.segment_file,
        } : {}),
        path: published.output_file,
        data_row_count: published.data_row_count, sha256: published.sha256,
      });
    } catch (error) {
      const reasonCode = reason(error, 'output_publish_failed');
      if (isFatalReason(reasonCode)) throw codedError(reasonCode);
      artifacts.push({
        status: 'failed',
        ...(item.artifact.logical_table !== undefined ? { logical_table: item.artifact.logical_table } : {}),
        ...(item.artifact.campaign_id !== undefined ? {
          campaign_id: String(item.artifact.campaign_id), campaign_name: item.artifact.campaign_name,
        } : {}),
        ...(item.artifact.product_id !== undefined ? {
          product_id: String(item.artifact.product_id), product_name: item.artifact.product_name,
        } : {}),
        ...(item.artifact.metric_date !== undefined ? { metric_date: item.artifact.metric_date } : {}),
        ...(item.artifact.segment_file !== undefined ? {
          segment_index: item.artifact.segment_index, segment_count: item.artifact.segment_count,
          segment_start_date: item.artifact.segment_start_date, segment_end_date: item.artifact.segment_end_date,
          segment_file: item.artifact.segment_file,
        } : {}),
        reason_code: reasonCode,
      });
    }
  }
  if (spec.output_granularity === 'source_segment' && artifacts.length
    && artifacts.every((item) => ['success', 'no_data'].includes(item.status))) {
    try {
      const directories = new Set(files.map((file) => path.dirname(file)));
      const expected = new Set(files.map((file) => path.resolve(file)));
      const pattern = new RegExp(spec.segment_publication.filename_pattern, 'u');
      for (const directory of directories) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const candidate = path.resolve(directory, entry.name);
          if (entry.isFile() && pattern.test(entry.name) && !expected.has(candidate)) fs.unlinkSync(candidate);
        }
        const actual = fs.readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && pattern.test(entry.name)).map((entry) => path.resolve(directory, entry.name));
        if (actual.length !== [...expected].filter((file) => path.dirname(file) === directory).length
          || actual.some((file) => !expected.has(file))) throw codedError('segment_collection_reread_failed');
      }
    } catch (error) {
      artifacts.push({ status: 'failed', reason_code: reason(error, 'old_segment_cleanup_failed') });
    }
  }
  return {
    report_id: spec.report_id, status: aggregateArtifactStatus(artifacts), files,
    data_row_count: artifacts.reduce((total, item) => total + (item.data_row_count || 0), 0), artifacts,
  };
}

function publishRunnerResult(result, spec, context, stagingDir, dependencies = {}) {
  return Array.isArray(result?.artifacts)
    ? publishMultiRunnerOutput(result, spec, context, stagingDir, dependencies)
    : publishRunnerOutput(result, spec, context, stagingDir, dependencies);
}

function aggregateStatus(reports, fatal) {
  if (fatal) return 'failed';
  if (reports.some((item) => item.status === 'partial')) return 'partial';
  const completed = reports.filter((item) => item.status === 'success' || item.status === 'no_data');
  if (!completed.length) return 'failed';
  if (completed.length !== reports.length) return 'partial';
  return completed.some((item) => item.status === 'success') ? 'success' : 'no_data';
}

async function executeExport(request, dependencies = {}) {
  let parsed = null; let session = null;
  try {
    validateRequestShape(request);
    const loaded = (dependencies.loadReportMd || loadReportMd)(dependencies.mdOptions);
    parsed = (dependencies.parseRunRequest || parseRunRequest)(request, { loaded });
    session = await (dependencies.createRunSession || createRunSession)(request, {
      ...(dependencies.sessionDependencies || {}), loaded,
    });
    const context = session.runContext; const reports = []; const warnings = []; let fatal = false;
    try { assertRunContextBinding(context, parsed); }
    catch (error) {
      const [first, ...remaining] = parsed.report_ids;
      const stopped = first ? [failedReport(first, reason(error)), ...remaining.map((reportId) => failedReport(reportId, 'task_aborted_after_fatal_failure'))] : [];
      return {
        schema_version: 'export_result_v1', request_id: context?.request_id || null, status: 'failed',
        shop_id: context?.shop_id || null, report_ids: [...parsed.report_ids], reports: stopped,
      };
    }
    try { (dependencies.ensureManualCostTable || ensureManualCostTable)(context.shop_root); }
    catch (error) {
      warnings.push({
        code: 'manual_cost_table_create_failed', reason_code: reason(error, 'manual_cost_table_create_failed'),
        file: manualCostTablePath(context.shop_root),
      });
    }
    for (let index = 0; index < context.report_ids.length; index += 1) {
      const reportId = context.report_ids[index]; const spec = loaded.specs[reportId];
      if (fatal) { reports.push(failedReport(reportId, 'task_aborted_after_fatal_failure')); continue; }
      let stagingDir = null; let reportResult;
      try {
        assertSessionAlive(session);
        const providerSpec = selectProvider(spec, context.provider_id);
        const runner = loadProviderRunner(loaded.skill_root, spec, providerSpec, dependencies.requireModule || require);
        if (typeof runner !== 'function') throw codedError('report_runner_abi_invalid');
        stagingDir = (dependencies.makeStagingDir || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-export-'))))();
        const result = await runner(
          buildRunnerInput(context, spec, providerSpec, stagingDir),
          { browser: session.browser, browserContext: session.browserContext, skillRoot: loaded.skill_root },
        );
        assertSessionAlive(session);
        reportResult = publishRunnerResult(result, spec, context, stagingDir, dependencies);
      } catch (error) {
        const reasonCode = reason(error); reportResult = failedReport(reportId, reasonCode, error?.diagnostics);
        fatal = isFatalReason(reasonCode);
      } finally {
        if (stagingDir) try {
          (dependencies.removeStagingDir || ((directory) => fs.rmSync(directory, { recursive: true, force: true })))(stagingDir);
        } catch { reportResult.cleanup_warning = 'staging_cleanup_failed'; }
      }
      reports.push(reportResult);
    }
    return {
      schema_version: 'export_result_v1', request_id: context.request_id,
      status: aggregateStatus(reports, fatal), shop_id: context.shop_id,
      report_ids: [...context.report_ids], reports,
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (error) {
    return failedResult(reason(error, 'export_failed'), parsed, session?.runContext);
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

function parseCliArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--request-json') throw codedError('invalid_arguments');
  let request;
  try { request = JSON.parse(argv[1]); } catch { throw codedError('request_json_invalid'); }
  return request;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let result;
  try { result = await executeExport(parseCliArgs(argv), dependencies); }
  catch (error) { result = failedResult(reason(error, 'invalid_arguments')); }
  (dependencies.writeLine || ((value) => process.stdout.write(`${JSON.stringify(value)}\n`)))(result);
  return ['success', 'no_data'].includes(result.status) ? 0 : 2;
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = {
  aggregateArtifactStatus, aggregateStatus, assertRunContextBinding, assertSessionAlive, executeExport,
  inspectMultiRunnerOutput, inspectRunnerOutput, loadProviderRunner, main, outputVariables, parseCliArgs,
  publishMultiRunnerOutput, publishRunnerOutput, publishRunnerResult,
  selectProvider,
};
