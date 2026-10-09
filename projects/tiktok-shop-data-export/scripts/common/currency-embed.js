'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv, writeCsv } = require('./csv');
const { safeSegment, sha256File } = require('./file-check');
const { readFirstWorksheet, readZipEntries } = require('./xlsx_first_sheet');
const { zip } = require('./xlsx_writer');

function failed(reasonCode) { return { status: 'failed', reason_code: reasonCode }; }
function xml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function embedCsv(buffer, currencyCode) {
  const parsed = parseCsv(buffer, { bom: 'optional' });
  const headers = parsed.rows[0];
  const existing = headers.findIndex((header) => ['currency', 'currency_code', '币种'].includes(String(header).trim().toLowerCase()));
  const rows = parsed.rows.map((row, index) => {
    const output = [...row];
    if (existing < 0) output.push(index === 0 ? 'currency' : currencyCode);
    else if (index > 0) {
      const observed = String(output[existing] || '').trim().toUpperCase();
      if (observed && observed !== currencyCode) throw Object.assign(new Error('currency_evidence_conflict'), { code:'currency_evidence_conflict' });
      output[existing] = currencyCode;
    }
    return output;
  });
  return { rows, bom: parsed.has_bom };
}

function appendCustomProperty(source, name, value) {
  const propertyPattern = new RegExp(`<property\\b([^>]*\\bname="${name}")[^>]*>[\\s\\S]*?<\\/property>`, 'u');
  const pid = name === 'Currency' ? 2 : 3;
  const replacement = `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid}" name="${xml(name)}"><vt:lpwstr>${xml(value)}</vt:lpwstr></property>`;
  if (propertyPattern.test(source)) return source.replace(propertyPattern, replacement);
  return source.replace('</Properties>', `${replacement}</Properties>`);
}

function embedXlsx(buffer, currencyCode, currencySymbol) {
  const entries = readZipEntries(buffer);
  const contentTypesName = '[Content_Types].xml'; const relsName = '_rels/.rels'; const customName = 'docProps/custom.xml';
  let contentTypes = entries.get(contentTypesName)?.toString('utf8');
  let relationships = entries.get(relsName)?.toString('utf8');
  if (!contentTypes || !relationships) throw Object.assign(new Error('xlsx_package_invalid'), { code:'xlsx_package_invalid' });
  if (!contentTypes.includes('application/vnd.openxmlformats-officedocument.custom-properties+xml')) {
    contentTypes = contentTypes.replace('</Types>', '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>');
  }
  if (!relationships.includes('relationships/custom-properties')) {
    const ids = [...relationships.matchAll(/\bId="rId(\d+)"/gu)].map((match) => Number(match[1]));
    const nextId = Math.max(0, ...ids) + 1;
    relationships = relationships.replace('</Relationships>', `<Relationship Id="rId${nextId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`);
  }
  let custom = entries.get(customName)?.toString('utf8')
    || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';
  custom = appendCustomProperty(custom, 'Currency', currencyCode);
  custom = appendCustomProperty(custom, 'CurrencySymbol', currencySymbol);
  entries.set(contentTypesName, Buffer.from(contentTypes)); entries.set(relsName, Buffer.from(relationships)); entries.set(customName, Buffer.from(custom));
  return zip([...entries.entries()]);
}

function embedCurrencyInner(options) {
  const { file, evidence } = options;
  if (!file || !fs.statSync(file, { throwIfNoEntry:false })?.isFile()) return failed('currency_data_file_missing');
  if (!evidence || !/^[A-Z]{3}$/u.test(String(evidence.currency_code || '')) || typeof evidence.currency_symbol !== 'string') return failed('currency_evidence_invalid');
  let task;
  try { task = safeSegment(options.taskId); } catch { return failed('task_id_invalid'); }
  const extension = path.extname(file).toLowerCase(); const temporary = `${file}.task-${task}-${process.pid}.currency.tmp${extension}`;
  let created = false;
  try {
    if (extension === '.csv') {
      const transformed = embedCsv(fs.readFileSync(file), evidence.currency_code);
      writeCsv(temporary, transformed.rows, { bom: transformed.bom }); created = true;
      const checked = parseCsv(fs.readFileSync(temporary), { bom:'optional' });
      if (!checked.rows[0].some((header) => ['currency','currency_code','币种'].includes(String(header).trim().toLowerCase()))) return failed('currency_embed_verify_failed');
    } else if (extension === '.xlsx') {
      fs.writeFileSync(temporary, embedXlsx(fs.readFileSync(file), evidence.currency_code, evidence.currency_symbol), { flag:'wx' }); created = true;
      const entries = readZipEntries(fs.readFileSync(temporary)); readFirstWorksheet(fs.readFileSync(temporary));
      const custom = entries.get('docProps/custom.xml')?.toString('utf8') || '';
      if (!custom.includes(`<vt:lpwstr>${xml(evidence.currency_code)}</vt:lpwstr>`)) return failed('currency_embed_verify_failed');
    } else return failed('currency_embed_format_unsupported');
    fs.renameSync(temporary, file); created = fs.existsSync(temporary);
    return { status:'success', output_file:file, sha256:sha256File(file), currency_code:evidence.currency_code };
  } finally {
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function embedCurrency(options = {}) {
  try { return embedCurrencyInner(options); } catch (error) { return failed(error.code || 'currency_embed_failed'); }
}

module.exports = { embedCurrency };
