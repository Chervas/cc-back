'use strict';

const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  for (const file of ['clinicgoogleadsaccount', 'googleconnectionassignment', 'externalcampaignassignment', 'googleadsinsightsdaily', 'adattributionissue']) {
    const model = require(`../../../models/${file}`)(sql, DataTypes); models[model.name] = model;
    await model.sync();
  }
  models.Clinica = sql.define('Clinica', { id_clinica: { type: DataTypes.INTEGER, primaryKey: true }, grupoClinicaId: DataTypes.INTEGER, nombre_clinica: DataTypes.STRING },
    { tableName: 'Clinicas', timestamps: false });
  await models.Clinica.sync();
  models.GrupoClinica = sql.define('GrupoClinica', { id_grupo: { type: DataTypes.INTEGER, primaryKey: true },
    ads_assignment_mode: DataTypes.STRING, ads_assignment_delimiter: DataTypes.STRING }, { tableName: 'GruposClinicas', timestamps: false });
  await models.GrupoClinica.sync();
  await models.GrupoClinica.create({ id_grupo: 5, ads_assignment_mode: 'automatic', ads_assignment_delimiter: '**' });
  const { collectGoogleCampaignMetrics, persistGoogleCampaignMetrics } = require('../../services/googleCampaignMetricsCache.service');
  const account = (await models.ClinicGoogleAdsAccount.create({ id: 11, customerId: '1234567890', googleConnectionId: 23,
    isActive: true, assignmentScope: 'group', grupoClinicaId: 5, clinicaId: 36, currencyCode: 'EUR', timeZone: 'Europe/Madrid' })).get({ plain: true });
  await models.ClinicGoogleAdsAccount.create({ ...account, id: 20, assignmentScope: 'clinic', clinicaId: 59 });
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5, nombre_clinica: 'Sede A' }, { id_clinica: 36, grupoClinicaId: 5, nombre_clinica: 'Sede B' }]);
  await models.GoogleConnectionAssignment.create({ scopeKey: 'group:5', assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 23, status: 'active' });
  await models.ExternalCampaignAssignment.create({ provider: 'google_ads', customer_id: account.customerId, campaign_id: '456', clinica_id: 59 });
  const baseTime = new Date('2026-09-12T01:00:00Z');
  let names = {};
  const resource = id => ({ customer: { id: account.customerId }, campaign: { id, name: names[id] || 'Campaign', status: 'ENABLED' } });
  const metric = (id, group) => ({ ...resource(id), ...(group ? { adGroup: { id: group, name: 'Group' } } : {}),
    segments: { date: '2026-09-10', device: 'MOBILE', adNetworkType: 'SEARCH' }, metrics: { costMicros: '1000000', clicks: '2', impressions: '10' } });
  const collect = (time = baseTime, empty = false) => collectGoogleCampaignMetrics({ account, start: '2026-09-09', end: '2026-09-10',
    now: () => time, clock: () => +time,
    read: async ({ query }) => /FROM customer/.test(query) ? [{ customer: { id: account.customerId, currencyCode: 'EUR', timeZone: 'Europe/Madrid', manager: false } }]
      : !/metrics\./.test(query) ? [resource('456'), resource('457')]
        : empty ? [] : /FROM ad_group /.test(query) ? [metric('456', '800')] : [metric('456'), metric('457')] });
  const seed = { clinicGoogleAdsAccountId: 20, customerId: account.customerId, campaignId: '456', date: '2026-09-10', costMicros: 9000000,
    updated_at: new Date('2026-09-11T01:00:00Z') };
  await models.GoogleAdsInsightsDaily.bulkCreate([seed, { ...seed, customerId: '9999999999' }, { ...seed, date: '2026-09-08' }]);
  const snapshot = await collect();
  const apply = (snapshot, extra = {}) => persistGoogleCampaignMetrics({ models, account, snapshot, now: new Date('2026-09-12T01:01:00Z'), ...extra });
  let backup;
  await apply(snapshot, { beforeReplace: async ({ where, transaction }) => { backup = await models.GoogleAdsInsightsDaily.findAll({ where, transaction, raw: true }); } });
  assert.equal(backup.length, 1); assert.equal(backup[0].clinicGoogleAdsAccountId, 20);
  assert.equal(await models.GoogleAdsInsightsDaily.count(), 6);
  assert.equal(Number((await models.GoogleAdsInsightsDaily.findOne({ where: { campaignId: '456', date: '2026-09-10', customerId: account.customerId } })).costMicros), 1000000);
  assert.equal(await models.GoogleAdsInsightsDaily.sum('costMicros'), 20000000);
  assert.equal(await models.GoogleAdsInsightsDaily.count({ where: { clinicaId: 59 } }), 2);
  assert.equal((await models.ClinicGoogleAdsAccount.findByPk(account.id)).lastSyncedAt, null, 'metric refresh does not claim inventory/ads sync');
  report.checks.push('account-and-window-replacement', 'two-mappings-no-double-count', 'human-assignment', 'real-models-without-ad-migration', 'backup-before-delete');
  const bulk = models.GoogleAdsInsightsDaily.bulkCreate.bind(models.GoogleAdsInsightsDaily);
  models.GoogleAdsInsightsDaily.bulkCreate = async () => { throw Error('injected_write_failure'); };
  await assert.rejects(apply(await collect(new Date(+baseTime + 1000))), /injected_write_failure/);
  models.GoogleAdsInsightsDaily.bulkCreate = bulk;
  assert.equal(await models.GoogleAdsInsightsDaily.sum('costMicros'), 20000000);
  report.checks.push('transaction-rollback');
  const newer = await collect(new Date(+baseTime + 3000)); const older = await collect(new Date(+baseTime + 2000), true);
  const lock = await sql.transaction();
  await models.ClinicGoogleAdsAccount.findAll({ where: { customerId: account.customerId }, transaction: lock, lock: lock.LOCK.UPDATE });
  const find = models.ClinicGoogleAdsAccount.findAll.bind(models.ClinicGoogleAdsAccount); let entered = 0;
  models.ClinicGoogleAdsAccount.findAll = async (...args) => { entered++; return find(...args); };
  const a = apply(newer); while (entered < 1) await new Promise(resolve => setTimeout(resolve, 5));
  const b = apply(older); while (entered < 2) await new Promise(resolve => setTimeout(resolve, 5));
  await lock.commit(); const answers = await Promise.all([a, b]);
  assert.equal(answers[0].skipped, false); assert.equal(answers[1].reason, 'newer_snapshot');
  assert.equal(await models.GoogleAdsInsightsDaily.sum('costMicros'), 20000000);
  report.checks.push('serialized-concurrent-refresh', 'older-empty-snapshot-cannot-erase');
  names = { '456': '**Sede B**', '457': '**Sede desconocida**' };
  await apply(await collect(new Date(+baseTime + 5000)), { useGroupAttribution: true });
  assert.equal(await models.AdAttributionIssue.count({ where: { customer_id: account.customerId, status: 'open' } }), 1);
  assert.equal(await models.GoogleAdsInsightsDaily.count({ where: { customerId: account.customerId, campaignId: '456', clinicaId: 59 } }), 2);
  assert.equal((await models.AdAttributionIssue.findOne()).grupo_clinica_id, 5);
  report.checks.push('scheduled-reviewed-attribution', 'scoped-automatic-issue');
  names = { '456': '**Sede B**', '457': '**Sede A**' };
  await assert.rejects(apply(await collect(new Date(+baseTime + 6000)), { useGroupAttribution: true,
    beforeReplace: async () => { throw Error('abort_scheduled_refresh'); } }), /abort_scheduled_refresh/);
  assert.equal(await models.AdAttributionIssue.count({ where: { status: 'open' } }), 1);
  report.checks.push('attribution-issue-rollback');
  await models.GoogleConnectionAssignment.update({ status: 'revoked' }, { where: { scopeKey: 'group:5' } });
  await assert.rejects(apply(await collect(new Date(+baseTime + 7000))), /grant_changed/);
  assert.equal(await models.GoogleAdsInsightsDaily.sum('costMicros'), 20000000);
  report.checks.push('grant-revocation');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
