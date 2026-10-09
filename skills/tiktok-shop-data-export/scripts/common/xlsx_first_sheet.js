const path = require('path');
const zlib = require('zlib');

class XlsxFirstSheetError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = 'XlsxFirstSheetError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = null) {
  throw new XlsxFirstSheetError(code, message, detail);
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('xlsx_zip_eocd_missing', 'XLSX ZIP end-of-central-directory record was not found');
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    fail('xlsx_zip_buffer_invalid', 'XLSX payload is not a valid ZIP buffer');
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail('xlsx_zip_central_directory_invalid', 'XLSX ZIP central-directory entry is invalid', { index, offset });
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
    if ((flags & 0x1) !== 0) fail('xlsx_zip_encrypted_entry', 'Encrypted XLSX ZIP entries are not supported', { name });
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      fail('xlsx_zip_local_header_invalid', 'XLSX ZIP local header is invalid', { name, local_header_offset: localHeaderOffset });
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else fail('xlsx_zip_compression_unsupported', 'XLSX ZIP compression method is unsupported', { name, method });
    if (data.length !== uncompressedSize) {
      fail('xlsx_zip_entry_size_mismatch', 'XLSX ZIP entry size differs from the central-directory contract', {
        name,
        expected_size: uncompressedSize,
        actual_size: data.length,
      });
    }
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(value, name) {
  const match = String(value || '').match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function extractTextRuns(xml) {
  const values = [];
  for (const match of String(xml || '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) values.push(decodeXml(match[1]));
  return values.join('');
}

function parseSharedStrings(buffer) {
  if (!buffer) return [];
  const xml = buffer.toString('utf8');
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => extractTextRuns(match[1]));
}

function cellReference(value) {
  const match = String(value || '').match(/^([A-Z]+)(\d+)$/i);
  if (!match) fail('xlsx_cell_reference_invalid', 'Worksheet cell reference is invalid', { reference: value });
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  return { rowIndex: Number(match[2]) - 1, columnIndex: column - 1 };
}

function parseWorksheet(buffer, sharedStrings) {
  if (!buffer) fail('xlsx_first_worksheet_missing', 'XLSX first worksheet XML is missing');
  const xml = buffer.toString('utf8');
  const cells = [];
  let maxRow = -1;
  let maxColumn = -1;
  for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const reference = attr(match[1], 'r');
    if (!reference) continue;
    const { rowIndex, columnIndex } = cellReference(reference);
    const type = attr(match[1], 't');
    const body = match[2];
    const valueMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
    let value = '';
    if (type === 'inlineStr') value = extractTextRuns(body);
    else if (type === 's') {
      const sharedIndex = valueMatch ? Number(valueMatch[1]) : Number.NaN;
      if (!Number.isInteger(sharedIndex) || sharedIndex < 0 || sharedIndex >= sharedStrings.length) {
        fail('xlsx_shared_string_index_invalid', 'XLSX shared-string index is invalid', { reference, shared_index: sharedIndex });
      }
      value = sharedStrings[sharedIndex];
    } else if (valueMatch) value = decodeXml(valueMatch[1]);
    cells.push({ rowIndex, columnIndex, value });
    maxRow = Math.max(maxRow, rowIndex);
    maxColumn = Math.max(maxColumn, columnIndex);
  }
  const rows = Array.from({ length: maxRow + 1 }, () => Array(maxColumn + 1).fill(''));
  for (const cell of cells) rows[cell.rowIndex][cell.columnIndex] = cell.value;
  return { rows, headers: rows[0] || [], row_count: rows.length, column_count: maxColumn + 1 };
}

function firstWorksheetPath(entries) {
  const workbook = entries.get('xl/workbook.xml');
  const relationships = entries.get('xl/_rels/workbook.xml.rels');
  if (workbook && relationships) {
    const sheet = workbook.toString('utf8').match(/<sheet\b([^>]*)\/?\s*>/);
    const relationId = sheet && attr(sheet[1], 'r:id');
    if (relationId) {
      for (const relation of relationships.toString('utf8').matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
        if (attr(relation[1], 'Id') !== relationId) continue;
        const target = attr(relation[1], 'Target');
        if (target) return path.posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

function readFirstWorksheet(buffer) {
  const entries = readZipEntries(buffer);
  const sheetPath = firstWorksheetPath(entries);
  const parsed = parseWorksheet(entries.get(sheetPath), parseSharedStrings(entries.get('xl/sharedStrings.xml')));
  return { ...parsed, sheet_path: sheetPath };
}

module.exports = {
  XlsxFirstSheetError,
  cellReference,
  decodeXml,
  parseWorksheet,
  readFirstWorksheet,
  readZipEntries,
};
