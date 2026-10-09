'use strict';

const crypto = require('crypto');
const { countCsvDataRows } = require('../../common/official_download_rows');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function validDate(value) { const parsed = new Date(`${value}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || '')) && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function epoch(date, timeZone, end = false) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/u); if (!match) fail('invalid_date');
  const target = [+match[1], +match[2], +match[3], ...(end ? [23, 59, 59, 999] : [0, 0, 0, 0])];
  let value = Date.UTC(target[0], target[1] - 1, ...target.slice(2));
  const format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', fractionalSecondDigits:3 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(value)).map((item) => [item.type, item.value]));
    const observed = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second, +parts.fractionalSecond);
    value += Date.UTC(target[0], target[1] - 1, ...target.slice(2)) - observed;
  }
  return value;
}
function reportUrl(origin, entry, start, end, timeZone, ui) {
  const url = new URL(entry, origin);
  url.searchParams.set(ui.entry_query.selected_sort.name, ui.entry_query.selected_sort.value);
  url.searchParams.set(ui.entry_query.tab.name, ui.entry_query.tab.value);
  url.searchParams.append(ui.entry_query.created_time, String(epoch(start, timeZone)));
  url.searchParams.append(ui.entry_query.created_time, String(epoch(end, timeZone, true)));
  return url;
}
function inspectCsv(buffer, spec, providerSpec) {
  return countCsvDataRows(buffer, providerSpec.official_validation.data_start_row);
}

module.exports = { inspectCsv, reportUrl, sha256, validDate };
