'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const PRIVATE = 'FAKE_OFFLINE_SECRET_NEVER_USED_WITH_A_PROVIDER';

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  await sql.query('CREATE TABLE GruposClinicas (id_grupo INT PRIMARY KEY)');
  await sql.query('CREATE TABLE MetaConnections (id INT PRIMARY KEY)');
  models.Clinica = sql.define('Clinica', { id_clinica: { type: DataTypes.INTEGER, primaryKey: true }, grupoClinicaId: DataTypes.INTEGER },
    { tableName: 'Clinicas', timestamps: false });
  models.UsuarioClinica = sql.define('UsuarioClinica', { id_usuario: DataTypes.INTEGER, id_clinica: DataTypes.INTEGER,
    rol_clinica: DataTypes.STRING, estado_invitacion: DataTypes.STRING }, { tableName: 'UsuarioClinica', timestamps: false });
  await models.Clinica.sync(); await models.UsuarioClinica.sync();
  for (const file of ['ClinicMetaAsset', 'groupassetclinicassignment', 'socialstatsdaily']) {
    const model = require(`../../../models/${file}`)(sql, DataTypes); models[model.name] = model; await model.sync();
  }
  await sql.query('INSERT INTO GruposClinicas VALUES (5)'); await sql.query('INSERT INTO MetaConnections VALUES (123)');
  await models.Clinica.bulkCreate([{ id_clinica: 55, grupoClinicaId: 5 }, { id_clinica: 66, grupoClinicaId: 5 }]);
  await models.UsuarioClinica.bulkCreate([
    { id_usuario: 701, id_clinica: 55, rol_clinica: 'propietario', estado_invitacion: 'aceptada' },
    { id_usuario: 703, id_clinica: 66, rol_clinica: 'agencia', estado_invitacion: 'aceptada' },
    ...[55, 66].map(id_clinica => ({ id_usuario: 704, id_clinica, rol_clinica: 'agencia', estado_invitacion: 'aceptada' })),
  ]);
  await models.ClinicMetaAsset.create({ id: 22, clinicaId: 55, metaConnectionId: 123, assetType: 'facebook_page',
    metaAssetId: 'offline-fixture', metaAssetName: 'Fixture', isActive: true, pageAccessToken: PRIVATE, waAccessToken: PRIVATE,
    additionalData: { accessToken: PRIVATE } });
  await models.SocialStatsDaily.bulkCreate([
    { clinica_id: 55, asset_id: 22, asset_type: 'facebook_page', date: '2026-09-10', impressions: 30 },
    { clinica_id: 55, asset_id: 22, asset_type: 'facebook_page', date: '2026-09-11', impressions: 40 },
    { clinica_id: 66, asset_id: 22, asset_type: 'facebook_page', date: '2026-09-11', impressions: 900 },
  ]);
  const filename = require.resolve('../../controllers/socialstats.controller');
  const localRequire = createRequire(filename); const module = { exports: {} }; const logs = [];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date, Object,
    require: name => name === '../services/notifications.service' ? {} : localRequire(name),
    console: { error: (...args) => logs.push(args) } }, { filename });
  const queryLog = [];
  sql.options.logging = query => queryLog.push(query);
  const call = async (userId, period = 'day') => {
    let response; let status = 200; let cache;
    await module.exports.getAssetStats({ params: { assetId: '22' }, userData: { userId },
      query: { startDate: '2026-09-10', endDate: '2026-09-11', period } }, {
      set: (_, value) => { cache = value; }, status(value) { status = value; return this; },
      json(body) { response = JSON.parse(JSON.stringify(body)); return this; },
    });
    assert.ok(!JSON.stringify({ response, logs }).includes(PRIVATE));
    assert.equal(cache, 'private, no-store');
    return { status, response };
  };
  for (const period of ['day', 'week', 'month']) {
    const { status, response } = await call(701, period);
    assert.equal(status, 200); assert.equal(response.asset.id, 22);
    assert.equal(response.stats.reduce((sum, row) => sum + Number(row.impressions), 0), 70);
  }
  assert.ok(queryLog.every(query => !/pageAccessToken|waAccessToken|additionalData/.test(query)));
  report.checks.push('actual-sql-projections-and-day-week-month-aggregates-with-no-secret-column-read');
  report.checks.push('historical-foreign-clinic-metrics-excluded');
  queryLog.length = 0;
  assert.equal((await call(703)).status, 403);
  assert.ok(queryLog.every(query => !query.includes('SocialStatsDaily')));
  report.checks.push('stranger-denied-before-reading-metrics');
  await models.ClinicMetaAsset.update({ isActive: false }, { where: { id: 22 } });
  assert.equal((await call(701)).status, 200); assert.equal((await call(703)).status, 403);
  report.checks.push('inactive-history-preserves-read-scope');
  await models.ClinicMetaAsset.update({ assignmentScope: 'group', grupoClinicaId: 5, clinicaId: null }, { where: { id: 22 } });
  assert.equal((await call(701)).status, 403); assert.equal((await call(704)).status, 200);
  report.checks.push('group-aggregate-requires-complete-membership');
  await models.UsuarioClinica.update({ estado_invitacion: 'cancelada' }, { where: { id_usuario: 704, id_clinica: 66 } });
  assert.equal((await call(704)).status, 403);
  report.checks.push('membership-revocation-effective-on-next-read');
  sql.options.logging = false;
  assert.equal((await models.ClinicMetaAsset.findByPk(22)).pageAccessToken, PRIVATE);
  report.checks.push('reader-does-not-delete-or-change-worker-credentials');
}).catch(() => { console.error('ISOLATED_SOCIAL_ASSET_STATS_TEST_FAILED'); process.exitCode = 1; });
