'use strict';

function nextDate(value) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }
function payload(contract, startDate, endDate, channel, page) {
  const fields = contract.request_fields;
  return { [fields.root]: { [fields.time]: { [fields.start]: startDate, [fields.end]: nextDate(endDate) }, [fields.search]: { [fields.channel]: channel.type }, [fields.list_control]: { [fields.pagination]: { [fields.page]: page, [fields.size]: contract.page_size }, [fields.rules]: contract.rules } } };
}

module.exports = { payload };
