'use strict';

const { json, without } = require('../../common/shop-api-v3');

function addDay(value) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }
function row(record, contract) { return [String(record.video_id), json(record[contract.record_meta_field]), json(without(record, [contract.record_meta_field, 'video_id']))]; }

module.exports = { addDay, row };
