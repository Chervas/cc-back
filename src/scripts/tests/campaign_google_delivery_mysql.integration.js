'use strict';

const assert = require('node:assert/strict');
const { Sequelize, DataTypes, Op } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const baseMigration = require('../../../migrations/20260911190000-create-google-ad-inventory-cache');
const migration = require('../../../migrations/20260912010000-add-google-ad-delivery-observation');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface();
  models.ClinicGoogleAdsAccount = sql.define('ClinicGoogleAdsAccount', {
    id: { type: DataTypes.INTEGER, primaryKey: true }, customerId: DataTypes.STRING(32), isActive: DataTypes.BOOLEAN,
    assignmentScope: DataTypes.STRING(32), clinicaId: DataTypes.INTEGER, grupoClinicaId: DataTypes.INTEGER, googleConnectionId: DataTypes.INTEGER,
  }, { tableName: 'ClinicGoogleAdsAccounts', timestamps: false });
  models.ExternalCampaignAssignment = sql.define('ExternalCampaignAssignment', {
    provider: DataTypes.STRING(32), customer_id: DataTypes.STRING(32), campaign_id: DataTypes.STRING(64), status: DataTypes.STRING(32), clinica_id: DataTypes.INTEGER,
  }, { timestamps: false });
  models.GoogleConnectionAssignment = require('../../../models/googleconnectionassignment')(sql, DataTypes);
  models.Clinica = sql.define('Clinica', { id_clinica: { type: DataTypes.INTEGER, primaryKey: true }, grupoClinicaId: DataTypes.INTEGER },
    { tableName: 'Clinicas', timestamps: false });
  await models.ClinicGoogleAdsAccount.sync(); await models.ExternalCampaignAssignment.sync();
  await models.GoogleConnectionAssignment.sync(); await models.Clinica.sync();
  await models.GoogleConnectionAssignment.create({ scopeKey: 'clinic:901', assignmentScope: 'clinic', clinicaId: 901, googleConnectionId: 2, status: 'active' });
  await models.Clinica.create({ id_clinica: 901 });
  await sql.query('CREATE TABLE GruposClinicas (id_grupo INT PRIMARY KEY) ENGINE=InnoDB');
  await require('../../../migrations/20260323121000-create-google-ads-ad-insights-daily').up(qi, Sequelize);
  await baseMigration.up(qi, Sequelize);
  for (const file of ['googleadsadinventory', 'googleadsadsyncday', 'googleadsadinsightsdaily']) {
    const model = require(`../../../models/${file}`)(sql, DataTypes); models[model.name] = model;
  }
  const { persistAdSnapshot, normalizeAd } = require('../../services/googleAdCache.service');
  const { loadGoogleWorkspaceAds } = require('../../services/googleAdWorkspaceRead.service');
  const { aggregateReport, reportPeriod } = require('../../services/campaignWorkspaceReport.service');
  const { buildWorkspaceHealth } = require('../../services/campaignWorkspaceHealth.service');
  const { externalCampaignIdentityKey } = require('../../services/externalCampaignAssignmentTargets.service');
  const now = new Date('2026-09-11T12:00:00.123Z');
  const account = await models.ClinicGoogleAdsAccount.create({ id: 1, customerId: '1234567890', isActive: true,
    assignmentScope: 'clinic', clinicaId: 901, googleConnectionId: 2 });
  const row = (id = '700', primaryStatus = 'NOT_ELIGIBLE', approvalStatus = 'DISAPPROVED') => ({
    customer: { id: account.customerId }, campaign: { id: '456', status: 'ENABLED' }, adGroup: { id: '800', status: 'ENABLED' },
    adGroupAd: { status: 'ENABLED', primaryStatus, policySummary: { approvalStatus, reviewStatus: 'REVIEWED' }, ad: { id, name: `Ad ${id}` } },
    segments: { date: '2026-09-10', device: 'MOBILE', adNetworkType: 'SEARCH' }, metrics: { costMicros: '5000000' },
  });
  const campaign = { provider: 'google_ads', account_id: account.customerId, campaign_id: '456', clinicId: 901, name: 'Campaign',
    assigned: true, paused: false, status: 'ENABLED', destination: 'native', currency: 'EUR' };
  campaign.id = externalCampaignIdentityKey(campaign);
  const read = () => loadGoogleWorkspaceAds({ models, googleWhere: [{ customerId: account.customerId, campaignId: '456' }],
    dateWhere: { [Op.between]: ['2026-09-09', '2026-09-10'] } });
  const health = async () => buildWorkspaceHealth(aggregateReport({ campaigns: [campaign], ads: await read(),
    period: reportPeriod(30, now), now }), new Map(), now);
  await models.GoogleAdsAdInventory.create({ ...normalizeAd(row(), account), observedAt: now, present: true });
  assert.equal((await read())[0].status, 'UNKNOWN', 'old schema has no approval evidence');
  report.checks.push('old-schema-read-fallback');
  await migration.up(qi, Sequelize); await migration.up(qi, Sequelize);
  assert.equal((await models.GoogleAdsAdInventory.findOne()).deliveryObservation, null);
  report.checks.push('nullable-idempotent-migration');

  const args = { models, account, inventoryRows: [row(), row('701', 'LIMITED', 'APPROVED_LIMITED')],
    metricRows: [row(), row('701', 'LIMITED', 'APPROVED_LIMITED')], start: '2026-09-09', end: '2026-09-10', observedAt: now };
  await persistAdSnapshot(args);
  const saved = await models.GoogleAdsAdInventory.findOne({ where: { adId: '700' }, raw: true });
  assert.equal(saved.adStatus, 'ENABLED');
  assert.equal(typeof saved.deliveryObservation, 'object');
  assert.equal(saved.deliveryObservation.approvalStatus, 'DISAPPROVED');
  assert.equal(saved.deliveryObservation.observedAt, now.toISOString());
  assert.equal(+saved.observedAt, +now);
  assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2);
  report.checks.push('separate-policy-json-and-millisecond-freshness');
  const result = await health(); const block = result.healthBlocks.find(item => item.id === 'delivery');
  assert.equal(block.tone, 'critical'); assert.equal(block.findings.length, 2); assert.equal(result.affectedCount, 1);
  assert.deepEqual(result.rows[0].ads.map(ad => ad.current.spend), [5, 5]);
  report.checks.push('real-sql-to-report-to-health');

  await models.GoogleAdsAdInventory.update({ observedAt: new Date(+now + 1) }, { where: { adId: '700' }, silent: true });
  assert.equal((await read()).find(ad => ad.id === '700').status, 'UNKNOWN', 'old writers cannot freshen an older policy');
  report.checks.push('legacy-writer-cannot-freshen-policy');
  const bulk = models.GoogleAdsAdInsightsDaily.bulkCreate.bind(models.GoogleAdsAdInsightsDaily);
  models.GoogleAdsAdInsightsDaily.bulkCreate = async () => { throw Error('injected persistence failure'); };
  await assert.rejects(persistAdSnapshot({ ...args, inventoryRows: [row('700', 'ELIGIBLE', 'APPROVED')], observedAt: new Date(+now + 2) }), /injected/);
  models.GoogleAdsAdInsightsDaily.bulkCreate = bulk;
  assert.equal((await models.GoogleAdsAdInventory.findOne({ where: { adId: '700' } })).deliveryObservation.approvalStatus, 'DISAPPROVED');
  assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2);
  report.checks.push('failed-refresh-rolls-policy-and-metrics-back');

  let backupChecked = false;
  await assert.rejects(persistAdSnapshot({ ...args, observedAt: new Date(+now + 3), beforeReplace: async options => {
    const inventory = await models.GoogleAdsAdInventory.findAll({ where: options.inventoryWhere, transaction: options.transaction, raw: true });
    const metrics = await models.GoogleAdsAdInsightsDaily.findAll({ where: options.metricWhere, transaction: options.transaction, raw: true });
    const coverage = await models.GoogleAdsAdSyncDay.findAll({ where: options.coverageWhere, transaction: options.transaction, raw: true });
    assert.equal(inventory.length, 2); assert.equal(metrics.length, 2); assert.equal(coverage.length, 2);
    backupChecked = true; throw Error('backup_unavailable');
  } }), /backup_unavailable/);
  assert.equal(backupChecked, true);
  assert.equal(+(await models.GoogleAdsAdSyncDay.findOne()).observedAt, +now);
  assert.equal(await models.GoogleAdsAdInventory.count(), 2);
  report.checks.push('backup-scope-and-failure-before-write');

  const grantLock = await sql.transaction();
  let checks = 0;
  const findGrants = models.GoogleConnectionAssignment.findAll.bind(models.GoogleConnectionAssignment);
  models.GoogleConnectionAssignment.findAll = async (...args) => { checks++; return findGrants(...args); };
  try {
    await models.GoogleConnectionAssignment.update({ status: 'revoked' }, { where: { scopeKey: 'clinic:901' }, transaction: grantLock });
    const pending = persistAdSnapshot({ ...args, metricRows: [], observedAt: new Date(+now + 4) })
      .then(result => ({ result }), error => ({ error }));
    const deadline = Date.now() + 3000;
    while (!checks && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(checks > 0, 'refresh reaches the locked grant');
    await grantLock.commit();
    assert.match((await pending).error?.message || '', /grant_changed/);
  } finally {
    if (!grantLock.finished) await grantLock.rollback();
    models.GoogleConnectionAssignment.findAll = findGrants;
  }
  assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2);
  assert.equal(+(await models.GoogleAdsAdSyncDay.findOne()).observedAt, +now);
  await models.GoogleConnectionAssignment.update({ status: 'active' }, { where: { scopeKey: 'clinic:901' } });
  report.checks.push('concurrent-revocation-prevents-cache-replacement');

  await models.ExternalCampaignAssignment.create({ provider: 'google_ads', customer_id: '123-456-7890', campaign_id: '456', status: 'active', clinica_id: 902 });
  await assert.rejects(persistAdSnapshot({ ...args, observedAt: new Date(+now + 5) }), /assignment_outside_scope/);
  assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2);
  await models.ExternalCampaignAssignment.update({ status: 'archived' }, { where: { campaign_id: '456' } });
  await persistAdSnapshot({ ...args, observedAt: new Date(+now + 6) });
  assert.ok((await models.GoogleAdsAdInsightsDaily.findAll()).every(row => row.clinicaId === null));
  report.checks.push('out-of-scope-assignment-rejected-and-archive-preserved');

  await models.ClinicGoogleAdsAccount.update({ clinicaId: 902 }, { where: { id: account.id } });
  await assert.rejects(persistAdSnapshot({ ...args, observedAt: new Date(+now + 7) }), /account_changed/);
  assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2);
  await models.ClinicGoogleAdsAccount.update({ clinicaId: 901 }, { where: { id: account.id } });
  report.checks.push('changed-mapping-cannot-reuse-captured-scope');

  await migration.down(qi); await migration.down(qi);
  assert.ok((await read()).every(ad => ad.status === 'UNKNOWN'));
  assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2);
  await migration.up(qi, Sequelize);
  assert.equal((await models.GoogleAdsAdInventory.findOne()).deliveryObservation, null);
  report.checks.push('rollback-preserves-metrics-and-removes-only-policy');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
