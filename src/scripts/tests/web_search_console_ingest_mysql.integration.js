'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const model = require('../../../models/webscquerydaily')(sql, DataTypes);
  models.WebScQueryDaily = model;
  await model.sync();
  await sql.getQueryInterface().addConstraint(model.getTableName(), {
    fields: ['clinica_id', 'date', 'query_hash', 'page_url_hash'], type: 'unique', name: 'qa_sc_exact_key',
  });
  const { persistChangedRows } = require('../../lib/searchConsoleIngest');
  const keyFields = ['clinica_id', 'date', 'query_hash', 'page_url_hash'];
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const row = (query, clicks = 1) => ({ clinica_id: 900001, site_url: 'https://fictitious.invalid/', date: '2026-10-18',
    query, query_hash: hash(query), page_url: 'https://fictitious.invalid/page', page_url_hash: hash('page'),
    clicks, impressions: 3, ctr: clicks / 3, position: 1.2344 });
  const publish = (rows, chunkSize = 400) => sql.transaction(transaction => persistChangedRows({ model, rows, keyFields, transaction, chunkSize }));
  assert.equal((await publish([row('fictitious query')])).inserted, 1);
  const original = await model.findOne({ raw: true });
  assert.equal(original.ctr, '0.333333'); assert.equal(original.position, '1.234');
  const writes = [], originalBulk = model.bulkCreate;
  model.bulkCreate = async function (...args) { writes.push(args[0].length); return originalBulk.apply(this, args); };
  const unchanged = await publish([row('fictitious query')]);
  assert.equal(unchanged.unchanged, 1); assert.equal(unchanged.written, 0); assert.deepEqual(writes, []);
  assert.equal((await model.findOne({ raw: true })).updated_at.getTime(), original.updated_at.getTime());
  report.checks.push('mysql_decimal_rounding_unchanged_retry_has_no_update_and_preserves_timestamp');

  let batches = 0;
  model.bulkCreate = async function (...args) {
    if (++batches === 2) throw Error('FICTITIOUS_SECOND_BATCH_FAILURE');
    return originalBulk.apply(this, args);
  };
  await assert.rejects(publish([row('fictitious query', 2), row('fictitious new query')], 1), /FICTITIOUS_SECOND_BATCH_FAILURE/);
  assert.equal(await model.count(), 1);
  assert.equal((await model.findOne({ raw: true })).clicks, 1);
  model.bulkCreate = originalBulk;
  const retried = await publish([row('fictitious query', 2), row('fictitious new query')], 1);
  assert.equal(retried.updated, 1); assert.equal(retried.inserted, 1);
  assert.equal((await publish([row('fictitious query', 2), row('fictitious new query')])).written, 0);
  assert.equal(await model.count(), 2);
  report.checks.push('mysql_later_batch_failure_rolls_back_full_interval_and_retry_is_idempotent');
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
