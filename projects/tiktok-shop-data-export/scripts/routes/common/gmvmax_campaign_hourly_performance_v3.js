'use strict';

const { getPath } = require('../../common/shop-api-v3');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function dateSequence(startDate, endDate) {
  const dates = [];
  for (let value = startDate; value <= endDate;) {
    dates.push(value);
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    value = date.toISOString().slice(0, 10);
  }
  return dates;
}
function hourlyRows(body, campaign, date, contract, advertiserCurrency) {
  const response = contract.hourly_response; if (getPath(body, response.data) == null) return [];
  const categories = getPath(body, response.categories); const series = getPath(body, response.series);
  const metricFields = contract.hourly_metric_fields;
  const fieldNames = ['cost', 'impressions', 'clicks', 'orders', 'revenue', 'cost_per_order', 'roi'];
  if (!metricFields || fieldNames.some((field) => typeof metricFields[field] !== 'string' || !metricFields[field].trim())
    || new Set(fieldNames.map((field) => metricFields[field])).size !== fieldNames.length) fail('campaign_hourly_shape_invalid');
  if (typeof advertiserCurrency !== 'string' || !advertiserCurrency.trim()) fail('campaign_currency_missing');
  const hours = Array.from({ length: response.bucket_count }, (_, index) => response.hour_template.replace('{{HH}}', String(index).padStart(2, '0')));
  const seriesNames = Array.isArray(series) ? series.map((item) => String(item?.[response.series_name] || '')) : [];
  if (!Array.isArray(categories) || categories.length !== response.bucket_count || categories.some((value, index) => value !== hours[index])
    || !Array.isArray(series) || !series.length || series.some((item) => !String(item?.[response.series_name] || '').trim())
    || new Set(seriesNames).size !== series.length || fieldNames.some((field) => !seriesNames.includes(metricFields[field]))) fail('campaign_hourly_shape_invalid');
  const byName = new Map(series.map((item) => [String(item[response.series_name]), item[response.series_values]]));
  const values = fieldNames.map((field) => byName.get(metricFields[field]));
  if (values.some((items) => !Array.isArray(items) || items.length !== response.bucket_count
    || items.some((value) => !((typeof value === 'string') || (typeof value === 'number' && Number.isFinite(value)))))) fail('campaign_hourly_shape_invalid');
  return hours.map((hour, index) => [String(campaign.campaign_id), String(campaign.campaign_name), date, hour,
    values[0][index], values[1][index], values[2][index], values[3][index], values[4][index], values[5][index], values[6][index], advertiserCurrency.trim()]);
}

module.exports = { dateSequence, hourlyRows };
