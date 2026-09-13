'use strict';
const assert = require('node:assert/strict'); const { DataTypes: D } = require('sequelize'); const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const qi = sql.getQueryInterface(); const migration = require('../../../migrations/20260913120000-create-google-ads-enrollment');
  await require('./fixtures/google_ads_enrollment_mysql.fixture').installGoogleAdsEnrollmentTables({ sql, models });
  await migration.down(qi); await migration.up(qi);
  const [schema] = await sql.query("SELECT COLUMN_DEFAULT, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='GoogleAdsEnrollmentScopes' AND COLUMN_NAME='state'");
  assert.equal(schema[0].COLUMN_DEFAULT, 'blocked'); assert.equal(schema[0].COLUMN_TYPE, "enum('blocked','active')");
  const [fk] = await sql.query("SELECT COUNT(*) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME IN ('GoogleAdsEnrollmentScopes','GoogleAdsEnrollmentRequests')");
  assert.equal(Number(fk[0].n), 0);
  report.checks.push('actual enrollment DDL round trips empty, defaults scopes to blocked, and has no cascading foreign keys');
  await qi.createTable('Usuarios', { id_usuario: { type: D.INTEGER, primaryKey: true } });
  for (const [name, file] of [['GoogleConnection','googleconnection'], ['ClinicGoogleAdsAccount','clinicgoogleadsaccount'],
    ['GoogleAdsBrokerBinding','googleadsbrokerbinding'], ['GoogleAdsBrokerRevocation','googleadsbrokerrevocation'],
    ['GoogleOAuthBrokerBinding','googleoauthbrokerbinding'], ['SearchConsoleBrokerBinding','searchconsolebrokerbinding'],
    ['AnalyticsBrokerBinding','analyticsbrokerbinding'], ['GooglePropertyBrokerRevocation','googlepropertybrokerrevocation'],
    ['GoogleConnectionAssignment','googleconnectionassignment']]) {
    models[name] = require('../../../models/' + file)(sql, D); await models[name].sync();
  }
  models.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER }, { tableName: 'Clinicas', timestamps: false });
  models.UsuarioClinica = sql.define('UsuarioClinica', { id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
    id_usuario: D.INTEGER, id_clinica: D.INTEGER, rol_clinica: D.STRING(64), estado_invitacion: D.STRING(32) }, { tableName: 'UsuarioClinicas', timestamps: false });
  await models.Clinica.sync(); await models.UsuarioClinica.sync();
  await models.Clinica.bulkCreate([{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }, { id_clinica: 99, grupoClinicaId: 6 }]);
  const { MARKETING_WRITE_ROLES } = require('../../lib/role-helpers');
  await models.UsuarioClinica.bulkCreate([59,71].map(id => ({ id_usuario: 9, id_clinica: id, rol_clinica: MARKETING_WRITE_ROLES[0], estado_invitacion: 'aceptada' })));
  await models.GoogleConnection.create({ id: 2, googleUserId: 'fictitious-subject', accessToken: 'FICTITIOUS_UNUSED_ACCESS', refreshToken: null });
  await models.GoogleConnectionAssignment.create({ id: 1, scopeKey: 'group:5', assignmentScope: 'group', grupoClinicaId: 5, googleConnectionId: 2, status: 'active' });
  const S = models.GoogleAdsEnrollmentScope; const R = models.GoogleAdsEnrollmentRequest; const G = models.GoogleConnection;
  const scopeData = { scope_key: 'group:5', google_connection_id: 2, google_user_id: 'fictitious-subject', connection_ref: 'google:ads:test',
    asset_ref: 'ads-enroll:group:5', tenant_clinic_id: 59, root_customer_id: '9876543210', login_customer_id: null };
  await S.create(scopeData); await assert.rejects(migration.down(qi));
  let tokenReads = 0;
  G.addHook('beforeFind', options => { if (!options.attributes || options.attributes.includes('accessToken') || options.attributes.includes('refreshToken')) tokenReads++; });
  const legacy = require('../../services/googleLegacyCredentials.service').forModels(models);
  await assert.rejects(legacy.load(2), { code: 'google_oauth_legacy_closed' }); assert.equal(tokenReads, 0);
  await G.create({ id: 3, googleUserId: 'fictitious-subject', accessToken: 'FICTITIOUS_DUPLICATE_ACCESS' });
  await assert.rejects(legacy.load(3), { code: 'google_oauth_legacy_closed' }); assert.equal(tokenReads, 0);
  await G.destroy({ where: { id: 3 } });
  report.checks.push('a blocked enrollment scope alone closes legacy token loading by connection ID and duplicate Google subject');
  await G.update({ accessToken: null }, { where: { id: 2 } }); await S.update({ state: 'active' }, { where: { scope_key: 'group:5' } });
  const C = require('../../services/googleAdsEnrollment.contract');
  const { createGoogleAdsEnrollmentScope, createGoogleAdsEnrollmentScopeRepository } = require('../../services/googleAdsEnrollmentScope.service');
  const { hasMarketingClinicScopeAccess } = require('../../lib/marketingScopeAccess');
  const service = createGoogleAdsEnrollmentScope({ ...createGoogleAdsEnrollmentScopeRepository(() => models), enabled: () => true,
    authorize: (input, { transaction }) => hasMarketingClinicScopeAccess({ userId: input.actorId, clinicIds: input.clinicIds, access: 'write',
      globalAdminCheck: () => false, membershipModel: { findAll: options => models.UsuarioClinica.findAll({ ...options, logging: false,
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) }) } }) });
  const at = Date.now(); const input = { scopeKey: 'group:5', connectionId: 2, clinicIds: [59,71], actorId: 9,
    sessionRef: randomUUID(), sessionExpiresAt: at + 3600000 };
  const context = await service.capture(input); const captured = await service.assert(context); assert.equal(tokenReads, 0);
  assert.deepEqual(captured.clinicIds, [59,71]);
  const makeRow = () => ({ enrollment_id: randomUUID(), scope_key: captured.scope_key, google_connection_id: 2, google_user_id: captured.google_user_id,
    connection_ref: captured.connection_ref, scope_ref: captured.asset_ref, tenant_clinic_id: 59, customer_id: '1234567890', login_customer_id: '9876543210',
    clinic_ids: '[59,71]', clinic_count: 2, clinic_digest: captured.clinicDigest, scope_digest: captured.scopeDigest, mapping_id: null,
    actor_user_id: 9, session_ref: input.sessionRef, session_expires_at: new Date(input.sessionExpiresAt),
    prepare_request_id: randomUUID(), activate_request_id: randomUUID(), revoke_request_id: randomUUID(), state: 'prepare_pending',
    requested_at: new Date(at), updated_at: new Date(at), attempts: 0, next_attempt_at: new Date(at), lease_token: null, lease_until: null, last_error: null });
  const request = makeRow(); C.request(request);
  await sql.transaction(async transaction => { await service.assertNewCustomer(context, request.customer_id, { transaction }); await R.create(request, { transaction }); });
  assert.equal(C.request((await R.findByPk(request.enrollment_id)).get({ plain: true })).clinic_digest, captured.clinicDigest);
  await assert.rejects(R.create(makeRow()), error => error.name === 'SequelizeUniqueConstraintError');
  await assert.rejects(sql.transaction(transaction => service.assertNewCustomer(context, request.customer_id, { transaction })));
  report.checks.push('real scope/permission metadata permits a new request under locks and SQL uniqueness prevents a second owner');
  const holder = await sql.transaction(); const other = await sql.transaction();
  try {
    await service.assert(context, { transaction: holder });
    await sql.query('SET SESSION innodb_lock_wait_timeout=1', { transaction: other });
    await assert.rejects(S.update({ state: 'blocked' }, { where: { scope_key: 'group:5' }, transaction: other }), e => e.original?.code === 'ER_LOCK_WAIT_TIMEOUT');
  } finally { await other.rollback(); await holder.rollback(); }
  report.checks.push('scope assertions retain the approved scope lock through the surrounding transaction');
  const old = await sql.transaction();
  try {
    await S.findAll({ transaction: old }); await S.update({ state: 'blocked' }, { where: { scope_key: 'group:5' } });
    await assert.rejects(service.assert(context, { transaction: old }), { code: 'google_ads_enrollment_scope_conflict' });
  } finally { await old.rollback(); }
  await S.update({ state: 'active' }, { where: { scope_key: 'group:5' } });
  report.checks.push('an older REPEATABLE READ transaction cannot hide a newly blocked scope from a locking assertion');
  await models.UsuarioClinica.update({ estado_invitacion: 'pendiente' }, { where: { id_usuario: 9, id_clinica: 71 } });
  await assert.rejects(service.restore((await R.findByPk(request.enrollment_id)).get({ plain: true })), { code: 'google_discovery_scope_forbidden' });
  await models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_usuario: 9, id_clinica: 71 } });
  await models.Clinica.update({ grupoClinicaId: 5 }, { where: { id_clinica: 99 } });
  await assert.rejects(service.restore((await R.findByPk(request.enrollment_id)).get({ plain: true })), { code: 'google_ads_enrollment_scope_conflict' });
  await models.Clinica.update({ grupoClinicaId: 6 }, { where: { id_clinica: 99 } });
  report.checks.push('restoring an intent cannot absorb an added group member or a revoked membership');
  await models.ClinicGoogleAdsAccount.create({ id: 111, customerId: '333-333-3333', googleConnectionId: 2, clinicaId: 99,
    assignmentScope: 'group', grupoClinicaId: 6, isActive: false });
  await assert.rejects(sql.transaction(transaction => service.assertNewCustomer(context, '3333333333', { transaction })), { code: 'google_ads_enrollment_account_in_use' });
  report.checks.push('inactive foreign group mappings still exclude a new customer owner using the normalized customer ID');
  await S.destroy({ where: { scope_key: 'group:5' } });
  const callback = require('../../services/googleOAuthBroker.service').createGoogleOAuthBroker({ models, audit: {} });
  await assert.rejects(callback.assertLegacyAllowed(), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(callback.assertLegacyConnection({ id: 2, googleUserId: 'fictitious-subject' }), { code: 'google_oauth_legacy_closed' });
  await assert.rejects(legacy.load(2), { code: 'google_oauth_legacy_closed' }); await assert.rejects(migration.down(qi));
  assert.equal(await R.count(), 1); assert.equal(tokenReads, 0);
  report.checks.push('deleting the original scope preserves the request and closes OAuth, credential fallback and destructive schema rollback');
  await G.create({ id: 4, googleUserId: 'fictitious-race', accessToken: 'FICTITIOUS_NEVER_HYDRATED' });
  let injected = false; let hydrated = false;
  G.addHook('beforeFind', 'late_enrollment_marker', async options => {
    if (options.attributes?.includes('accessToken') && !injected) {
      injected = true; await S.create({ ...scopeData, scope_key: 'clinic:99', asset_ref: 'ads-enroll:clinic:99',
        tenant_clinic_id: 99, google_connection_id: 4, google_user_id: 'fictitious-race' });
    }
  });
  G.addHook('afterFind', 'enrollment_hydration_guard', (row, options) => { if (options.attributes?.includes('accessToken') && row) hydrated = true; });
  await assert.rejects(legacy.load(4), { code: 'google_oauth_legacy_closed' }); assert.equal(injected, true); assert.equal(hydrated, false);
  G.removeHook('beforeFind', 'late_enrollment_marker'); G.removeHook('afterFind', 'enrollment_hydration_guard');
  report.checks.push('a scope inserted after metadata checks wins in the same credential SELECT; no token row is hydrated');
  for (const table of ['GoogleAdsEnrollmentScopes','GoogleAdsEnrollmentRequests']) {
    const backup = 'OfflineHidden' + table; await qi.renameTable(table, backup);
    await assert.rejects(legacy.load(2), { code: 'google_credentials_unavailable' }); await qi.renameTable(backup, table);
  }
  report.checks.push('either missing enrollment table fails closed without attempting credential SELECT');
}).catch(() => { process.exitCode = 1; });
