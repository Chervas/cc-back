'use strict';
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.Sequelize = S;
  models.JobRequest = require('../../../models/jobrequest')(sql, S.DataTypes);
  await sql.sync();
  const { createService } = require('../../services/whatsappAuthorizedPhoneSync.service');
  const bindings = [1, 2].map(assetId => ({ connectionRef: 'synthetic-connection',
    authorizationId: 'a1234567-1234-4234-8234-123456789abc', clinicId: 35, assetId,
    phoneId: String(900000000 + assetId), wabaId: '800000001', revision: 1, sendEnabled: true }));
  let clock = new Date('2030-01-01T10:00:00Z');
  const completed = [], attempts = new Map();
  const service = createService({
    broker: { configuration: () => ({ bindings }), binding: async (clinicId, assetId) =>
      bindings.find(value => value.clinicId === clinicId && value.assetId === assetId) },
    loadAsset: async id => ({ id, assetType: 'whatsapp_phone_number', isActive: true }),
    refresh: async ({ asset }) => {
      attempts.set(asset.id, (attempts.get(asset.id) || 0) + 1);
      if (asset.id === 1 && attempts.get(1) === 1) throw Error('SYNTHETIC_PROVIDER_TIMEOUT');
      completed.push(asset.id); return { health: { state: 'healthy', can_send: true } };
    }, now: () => clock,
  });
  await Promise.all(Array.from({ length: 4 }, () => service.enqueue()));
  assert.equal(await models.JobRequest.count(), 2);
  const rows = await models.JobRequest.findAll({ order: [['id', 'ASC']] });
  assert(rows.every(row => row.type === 'whatsapp_phones_sync' && row.max_attempts === 3));
  assert(rows.every(row => row.payload.mode === 'authorized' && row.payload.expectedBinding));
  report.checks.push('four concurrent schedules commit exactly two native SQL jobs, one per physical phone, without Redis/provider access');

  await assert.rejects(service.run(rows[0].payload), /SYNTHETIC_PROVIDER_TIMEOUT/);
  await service.run(rows[1].payload);
  await service.run(rows[0].payload);
  assert.deepEqual(completed, [2, 1]);
  for (const row of rows) await row.update({ status: 'completed' });
  assert.equal((await service.enqueue()).queued, 0);
  assert.equal(await models.JobRequest.count(), 2);
  report.checks.push('one provider timeout leaves the other phone available; completed checks remain deduplicated by native transactional enqueue');

  clock = new Date(+clock + 3600000);
  assert.equal((await service.enqueue()).queued, 2);
  assert.equal(await models.JobRequest.count(), 4);
  bindings[0] = { ...bindings[0], revision: 2 };
  assert.equal((await service.run(rows[0].payload)).skipped, true);
  assert.deepEqual(completed, [2, 1]);
  report.checks.push('next hour creates a new pair; a rotated identity cannot reuse a queued check or change health');
});
