'use strict';

function dateError(code = 'invalid_date') { return Object.assign(new Error(code), { code }); }
function businessDate(now, timeZone) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now); }
  catch { throw dateError(); }
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function parseDate(value, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw dateError();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value > today) throw dateError();
  return value;
}
function resolveDateRange(input, now = new Date(), timeZone = 'UTC') {
  const date = input?.date || '';
  const start = input?.startDate || '';
  const end = input?.endDate || '';
  if (date && (start || end)) throw dateError('ambiguous_date_input');
  if (!date && (!start || !end)) throw dateError();
  const today = businessDate(now, timeZone);
  const startDate = parseDate(date || start, today);
  const endDate = parseDate(date || end, today);
  if (startDate > endDate) throw dateError();
  return { start_date: startDate, end_date: endDate, business_today: today, kind: startDate === endDate ? 'single_day' : 'date_range' };
}

module.exports = { businessDate, resolveDateRange };
