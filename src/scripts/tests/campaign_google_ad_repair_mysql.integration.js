'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Sequelize, DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { fixture } = require('./fixtures/propdental_ad_repair.fixture');
const { repair, saveJson } = require('../repair_propdental_ad_cache');
const { normalizeAd } = require('../../services/googleAdCache.service');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface(); const f = fixture();
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
  await sql.query('CREATE TABLE GruposClinicas (id_grupo INT PRIMARY KEY) ENGINE=InnoDB');
  await sql.query('INSERT INTO GruposClinicas (id_grupo) VALUES (5)');
  await models.Clinica.create({ id_clinica: 901, grupoClinicaId: 5 });
  await models.ClinicGoogleAdsAccount.create(f.account);
  const other = { ...f.account, id: 12, customerId: '9999999999' };
  await models.ClinicGoogleAdsAccount.create(other);
  await models.GoogleConnectionAssignment.create({ scopeKey: 'group:5', assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 2, status: 'active' });
  await models.ExternalCampaignAssignment.create({ provider: 'google_ads', customer_id: f.account.customerId, campaign_id: '456', status: 'active', clinica_id: 901 });
  await require('../../../migrations/20260323121000-create-google-ads-ad-insights-daily').up(qi, Sequelize);
  await require('../../../migrations/20260911190000-create-google-ad-inventory-cache').up(qi, Sequelize);
  for (const file of ['googleadsadinventory', 'googleadsadsyncday', 'googleadsadinsightsdaily']) {
    const model = require(`../../../models/${file}`)(sql, DataTypes); models[model.name] = model;
  }
  const args = { models, account: f.account, request: f.request, guard: async () => {}, now: () => f.now };
  const backup = async value => {
    const dir = fs.mkdtempSync(path.join(report.root, 'evidence-'));
    fs.chmodSync(dir, 0o700); const saved = saveJson(dir, 'before.json', value);
    assert.equal(fs.statSync(path.join(dir, saved.file)).mode & 0o777, 0o600);
    return { ...saved, directory: dir, counts: Object.fromEntries(Object.entries(value.rows).map(([key, rows]) => [key, rows.length])) };
  };
  await assert.rejects(repair({ ...args, backup }), /MIGRATION_REQUIRED/);
  assert.equal(f.calls.length, 0);
  report.checks.push('missing-schema-stops-before-provider-read');
  await require('../../../migrations/20260912010000-add-google-ad-delivery-observation').up(qi, Sequelize);

  const oldTime = new Date(+f.now - 86400000);
  const original = normalizeAd(f.inventoryRows[0], f.account);
  for (const account of [f.account, other]) {
    const ad = { ...original, customerId: account.customerId, clinicGoogleAdsAccountId: account.id };
    await models.GoogleAdsAdInventory.create({ ...ad, present: true, observedAt: oldTime });
    if (account.id === 11) await models.GoogleAdsAdInventory.create({ ...ad, adId: '777', present: true, observedAt: oldTime });
    for (const date of ['2026-07-13', '2026-07-15']) {
      await models.GoogleAdsAdInsightsDaily.create({ ...ad, date, costMicros: 999, observedAt: oldTime });
      await models.GoogleAdsAdSyncDay.create({ clinicGoogleAdsAccountId: account.id, customerId: account.customerId, date, observedAt: oldTime });
    }
  }
  const snapshot = async () => {
    const result = {};
    for (const name of ['GoogleAdsAdInventory', 'GoogleAdsAdInsightsDaily', 'GoogleAdsAdSyncDay']) {
      result[name] = await models[name].findAll({ raw: true, order: [['id', 'ASC']] });
    }
    return result;
  };
  const initial = await snapshot();
  await assert.rejects(repair({ ...args, backup: async () => { throw Error('backup_failed'); } }), /backup_failed/);
  assert.deepEqual(await snapshot(), initial);
  report.checks.push('backup-failure-preserves-all-three-tables');

  const saved = await repair({ ...args, backup });
  assert.equal(saved.persisted.skipped, false);
  assert.deepEqual(saved.verification, { inventoryRows: 3, presentAds: 2, metricRows: 3, completeDays: 60 });
  assert.deepEqual(saved.backup.counts, { inventory: 2, metrics: 1, coverage: 1 });
  assert.equal(saved.reconciliation.adCostMicros, '6000000');
  const current = await snapshot();
  for (const name of Object.keys(initial)) {
    assert.deepEqual(current[name].filter(row => row.clinicGoogleAdsAccountId === 12), initial[name].filter(row => row.clinicGoogleAdsAccountId === 12));
  }
  assert.deepEqual(current.GoogleAdsAdInsightsDaily.filter(row => row.date === '2026-07-13'), initial.GoogleAdsAdInsightsDaily.filter(row => row.date === '2026-07-13'));
  assert.equal(Boolean(current.GoogleAdsAdInventory.find(row => row.adId === '777').present), false);
  assert.ok(current.GoogleAdsAdInsightsDaily.filter(row => row.clinicGoogleAdsAccountId === 11 && row.date >= f.period.start).every(row => row.clinicaId === 901 && row.grupoClinicaId === 5));
  assert.equal(current.GoogleAdsAdInventory.find(row => row.clinicGoogleAdsAccountId === 11 && row.adId === '700').deliveryObservation.approvalStatus, 'APPROVED');
  report.checks.push('complete-repair-verifies-real-sql-and-restricted-backup');
  report.checks.push('other-account-and-outside-window-unchanged');
  report.checks.push('reviewed-clinic-and-historical-inventory-preserved');

  const bulk = models.GoogleAdsAdInsightsDaily.bulkCreate.bind(models.GoogleAdsAdInsightsDaily);
  models.GoogleAdsAdInsightsDaily.bulkCreate = async (rows, options) => bulk(rows.map((row, i) => i ? row : { ...row, costMicros: row.costMicros + 1 }), options);
  try {
    await assert.rejects(repair({ ...args, backup, now: () => new Date(+f.now + 1000) }), /AD_METRICS_VERIFICATION_FAILED/);
  } finally { models.GoogleAdsAdInsightsDaily.bulkCreate = bulk; }
  assert.deepEqual(await snapshot(), current);
  report.checks.push('post-write-mismatch-rolls-back-before-commit');

  let guards = 0;
  await assert.rejects(repair({ ...args, backup, now: () => new Date(+f.now + 2000), guard: async () => {
    if (++guards === 3) throw Error('incident_gate_changed');
  } }), /incident_gate_changed/);
  assert.equal(guards, 3); assert.deepEqual(await snapshot(), current);
  report.checks.push('changed-final-guard-rolls-back-before-commit');

  const changed = fixture(); changed.campaignRows[0].metrics.costMicros = '9000000';
  await assert.rejects(repair({ ...args, request: changed.request, backup }), /SEARCH_DAILY_SPEND_MISMATCH/);
  assert.deepEqual(await snapshot(), current);
  report.checks.push('unreconciled-provider-read-never-replaces-cache');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
