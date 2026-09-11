'use strict';

// Opt-in: creates and drops only a randomly named, isolated database. No provider requests.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../../../migrations/20260911190000-create-google-ad-inventory-cache');
const { persistAdSnapshot } = require('../../services/googleAdCache.service');

async function main() {
  if (process.env.GOOGLE_AD_CACHE_MYSQL_TEST !== '1') throw new Error('Set GOOGLE_AD_CACHE_MYSQL_TEST=1 to run the isolated MySQL test');
  const socketPath = process.env.GOOGLE_AD_CACHE_MYSQL_SOCKET;
  if (!socketPath || !/^\/tmp\/cc-google-ad-mysql-[A-Za-z0-9]+\/mysql.sock$/.test(socketPath)) throw new Error('A dedicated temporary MySQL socket is required');
  const config = { dialect: 'mysql', username: 'root', password: '', host: 'localhost', dialectOptions: { socketPath } };
  const database = `cc_qa_google_ad_${crypto.randomBytes(8).toString('hex')}`;
  assert.match(database, /^cc_qa_google_ad_[0-9a-f]{16}$/);
  const admin = new Sequelize({ ...config, database: undefined, logging: false });
  let sql; let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\``); created = true;
    sql = new Sequelize({ ...config, database, logging: false });
    const qi = sql.getQueryInterface();
    const models = { sequelize: sql };
    models.ClinicGoogleAdsAccount = sql.define('ClinicGoogleAdsAccount', {
      id: { type: DataTypes.INTEGER, primaryKey: true }, customerId: DataTypes.STRING(32), isActive: DataTypes.BOOLEAN,
      assignmentScope: DataTypes.STRING(32), clinicaId: DataTypes.INTEGER, grupoClinicaId: DataTypes.INTEGER, googleConnectionId: DataTypes.INTEGER,
    }, { tableName: 'ClinicGoogleAdsAccounts', timestamps: false });
    models.ExternalCampaignAssignment = sql.define('ExternalCampaignAssignment', {
      provider: DataTypes.STRING(32), customer_id: DataTypes.STRING(32), campaign_id: DataTypes.STRING(64), status: DataTypes.STRING(32), clinica_id: DataTypes.INTEGER,
    }, { timestamps: false });
    await models.ClinicGoogleAdsAccount.sync(); await models.ExternalCampaignAssignment.sync();
    await sql.query('CREATE TABLE GruposClinicas (id_grupo INT PRIMARY KEY) ENGINE=InnoDB');
    await require('../../../migrations/20260323121000-create-google-ads-ad-insights-daily').up(qi, Sequelize);
    await migration.up(qi, Sequelize); await migration.up(qi, Sequelize);
    for (const file of ['googleadsadinventory', 'googleadsadsyncday', 'googleadsadinsightsdaily']) {
      const model = require(`../../../models/${file}`)(sql, DataTypes); models[model.name] = model;
    }
    const account = await models.ClinicGoogleAdsAccount.create({ id: 1, customerId: '1234567890', isActive: true,
      assignmentScope: 'clinic', clinicaId: 1, googleConnectionId: 2 });
    const row = (group = '800', campaign = '456') => ({ customer: { id: '1234567890' }, campaign: { id: campaign, name: 'Campaign', status: 'ENABLED' },
      adGroup: { id: group, name: 'Group', status: 'ENABLED' }, adGroupAd: { status: 'ENABLED', ad: { id: '700', name: 'Ad',
        responsiveSearchAd: { headlines: [{ text: 'Title' }] } } },
      segments: { date: '2026-09-10', device: 'MOBILE', adNetworkType: 'SEARCH' }, metrics: { costMicros: '2500000' } });
    const args = { models, account, inventoryRows: [row(), row('801')], metricRows: [row(), row('801')],
      start: '2026-09-09', end: '2026-09-10', observedAt: new Date('2026-09-11T02:00:00.123Z') };
    await persistAdSnapshot(args);
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2, 'group identities coexist');
    assert.equal(await models.GoogleAdsAdInventory.count(), 2);
    assert.equal(await models.GoogleAdsAdSyncDay.count(), 2);
    assert.equal(+(await models.GoogleAdsAdInsightsDaily.findOne()).observedAt, +args.observedAt, 'millisecond freshness is retained');
    await assert.rejects(migration.down(qi), { name: 'SequelizeUniqueConstraintError' }, 'rollback refuses to collapse distinct group IDs');
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2);

    const original = models.GoogleAdsAdInsightsDaily.bulkCreate.bind(models.GoogleAdsAdInsightsDaily);
    models.GoogleAdsAdInsightsDaily.bulkCreate = async () => { throw new Error('injected persistence failure'); };
    await assert.rejects(persistAdSnapshot({ ...args, inventoryRows: [], observedAt: new Date('2026-09-11T02:01:00Z') }), /injected/);
    models.GoogleAdsAdInsightsDaily.bulkCreate = original;
    assert.equal(await models.GoogleAdsAdInventory.count({ where: { present: true } }), 2, 'inventory update rolled back');
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2, 'delete rolled back');
    assert.equal(+(await models.GoogleAdsAdSyncDay.findOne()).observedAt, +args.observedAt);

    const other = { ...args, campaignId: '457', inventoryRows: [row('900', '457')], metricRows: [row('900', '457')],
      observedAt: new Date('2026-09-11T02:02:00Z') };
    await persistAdSnapshot(other);
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 3, 'campaign query retains other campaign metrics');
    await persistAdSnapshot({ ...args, campaignId: '456', metricRows: [], observedAt: new Date('2026-09-11T02:03:00Z') });
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 1, 'complete zero query clears only that campaign');
    assert.equal((await models.GoogleAdsAdInsightsDaily.findOne()).campaignId, '457');

    const lock = await sql.transaction();
    await models.ClinicGoogleAdsAccount.findByPk(1, { transaction: lock, lock: lock.LOCK.UPDATE });
    let attempts = 0;
    const findByPk = models.ClinicGoogleAdsAccount.findByPk.bind(models.ClinicGoogleAdsAccount);
    models.ClinicGoogleAdsAccount.findByPk = async (...values) => { attempts++; return findByPk(...values); };
    const newer = persistAdSnapshot({ ...args, observedAt: new Date('2026-09-11T02:05:00Z') });
    while (attempts < 1) await new Promise(resolve => setTimeout(resolve, 5));
    const older = persistAdSnapshot({ ...args, metricRows: [], observedAt: new Date('2026-09-11T02:04:00Z') });
    while (attempts < 2) await new Promise(resolve => setTimeout(resolve, 5));
    await lock.commit();
    const results = await Promise.all([newer, older]);
    assert.equal(results[0].skipped, false); assert.equal(results[1].reason, 'newer_snapshot');
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2, 'stale concurrent response did not erase newer metrics');

    // Old writer shape remains accepted: observedAt and adGroupId are nullable.
    await models.GoogleAdsAdInsightsDaily.create({ clinicGoogleAdsAccountId: 1, customerId: account.customerId,
      campaignId: '456', adGroupId: null, adId: '701', date: '2026-09-08', network: '', device: '' });
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 3);
    await models.GoogleAdsAdInsightsDaily.destroy({ where: { adGroupId: '801' } });
    await migration.down(qi); await migration.up(qi, Sequelize);
    assert.equal(await models.GoogleAdsAdInsightsDaily.count(), 2, 'safe rollback preserves historical metric records');
    console.log(JSON.stringify({ success: true, database, checks: ['migration-idempotence', 'group-identity', 'millisecond-freshness',
      'rollback-collision', 'transaction-rollback', 'campaign-isolation', 'complete-empty-window', 'concurrent-refresh', 'old-writer-compatibility', 'migration-roundtrip'] }));
  } finally {
    if (sql) await sql.close();
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
