'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const OAuth = require('../../services/metaMarketingOAuth.contract');
const Enrollment = require('../../services/metaMarketingEnrollment.contract');
const Discovery = require('../../../services/integrations-broker/src/meta-marketing-discovery-contract');
const Admission = require('../../../services/integrations-broker/src/meta-marketing-admission-contract');

const CLINIC = 91077;
const ACTOR = 91001;
const LEGACY_CONNECTION = 91058;
const CANONICAL_CONNECTION = 91059;
const LEGACY_GRANT = 91023;
const LEGACY_PHONE = 91392;
const LEGACY_WABA = 91393;
const APP = '99101';
const SUBJECT = '99201';
const SCOPE = 'clinic:' + CLINIC;
const ACCOUNT = 'meta-ad_account:99301';
const PAGE = 'meta-facebook_page:99401';
const EXTRA_ACCOUNT = 'meta-ad_account:99302';
const SELECTED = [ACCOUNT, PAGE];

async function prepareModels(sql, models) {
  for (const [name, file] of [
    ['Clinica', 'clinica'],
    ['GrupoClinica', 'grupoclinica'],
    ['UsuarioClinica', 'usuarioclinica'],
    ['MetaScopeBlock', 'metascopeblock'],
    ['MetaConnection', 'MetaConecction'],
    ['MetaConnectionAssignment', 'metaconnectionassignment'],
    ['ClinicMetaAsset', 'ClinicMetaAsset'],
    ['GroupAssetClinicAssignment', 'groupassetclinicassignment'],
    ['MetaMarketingBrokerBinding', 'metamarketingbrokerbinding'],
    ['MetaMarketingBrokerRevocation', 'metamarketingbrokerrevocation'],
    ['PlatformAuditEvent', 'platformauditevent'],
    ['MetaMarketingOAuthSlot', 'metamarketingoauthslot'],
    ['MetaMarketingOAuthRequest', 'metamarketingoauthrequest'],
    ['MetaMarketingEnrollmentRequest', 'metamarketingenrollmentrequest'],
    ['MetaMarketingEnrollmentClaim', 'metamarketingenrollmentclaim'],
    ['MetaMarketingEnrollmentIdentity', 'metamarketingenrollmentidentity'],
    ['MetaMarketingRecovery', 'metamarketingrecovery'],
  ]) {
    const model = require('../../../models/' + file)(sql, DataTypes);
    for (const attribute of Object.values(model.rawAttributes)) delete attribute.references;
    model.refreshAttributes();
    await model.sync();
    models[name] = model;
  }
}

function asset(assetRef) {
  const [type, id] = assetRef.split(':');
  const kind = type.slice('meta-'.length);
  return {
    assetRef, kind, id, parentPageId: null, name: 'Activo ficticio ' + id,
    ...(kind === 'ad_account' ? { accountStatus: 1, currency: 'EUR', timezone: 'Europe/Madrid' } : {}),
  };
}

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  await prepareModels(sql, models);
  await models.Clinica.create({ id_clinica: CLINIC, nombre_clinica: 'Clínica ficticia', grupoClinicaId: null, estado_clinica: true });
  await models.UsuarioClinica.create({ id_usuario: ACTOR, id_clinica: CLINIC, rol_clinica: 'propietario', estado_invitacion: 'aceptada' });
  await models.MetaConnection.create({
    id: LEGACY_CONNECTION, userId: ACTOR, metaUserId: '99111', accessToken: 'FICTITIOUS_LEGACY_META',
    credentials_external: false, broker_app_id: null,
  });
  await models.MetaConnection.create({
    id: CANONICAL_CONNECTION, userId: null, metaUserId: SUBJECT, accessToken: null,
    credentials_external: true, broker_app_id: APP,
  });
  await models.MetaConnectionAssignment.create({
    id: LEGACY_GRANT, scopeKey: SCOPE, assignmentScope: 'clinic', clinicaId: CLINIC, grupoClinicaId: null,
    metaConnectionId: LEGACY_CONNECTION, status: 'active',
  });
  await models.ClinicMetaAsset.bulkCreate([
    { id: LEGACY_PHONE, assetType: 'whatsapp_phone_number', metaAssetId: '99901',
      isActive: true, waAccessToken: 'FICTITIOUS_LEGACY_WHATSAPP', whatsappAuthorizationId: randomUUID() },
    { id: LEGACY_WABA, assetType: 'whatsapp_business_account', metaAssetId: '99902', isActive: false },
  ].map(row => ({ ...row, metaConnectionId: LEGACY_CONNECTION, assignmentScope: 'clinic', clinicaId: CLINIC, grupoClinicaId: null })));
  const snapshotLegacy = async () => ({
    connection: await models.MetaConnection.findByPk(LEGACY_CONNECTION, { raw: true }),
    grants: await models.MetaConnectionAssignment.findAll({ raw: true, order: [['id', 'ASC']] }),
    phone: await models.ClinicMetaAsset.findByPk(LEGACY_PHONE, { raw: true }),
    account: await models.ClinicMetaAsset.findByPk(LEGACY_WABA, { raw: true }),
  });
  const legacyBefore = await snapshotLegacy();

  const started = Date.now();
  const now = () => new Date(started);
  let emailVerified = true;
  const sessions = {
    async verifyReference(reference, options) {
      assert.equal(reference.userId, ACTOR);
      assert.equal(options.requireEmail, true);
      assert.ok(options.transaction);
      if (!emailVerified) throw Object.assign(new Error('Unverified fixture session'), { code: 'auth_email_verification_required', status: 403 });
    },
  };
  const input = { scopeKey: SCOPE, actorId: ACTOR, sessionRef: randomUUID(), sessionExpiresAt: new Date(started + 3600000) };
  const scopes = ['ads_management', 'ads_read', 'leads_retrieval', 'pages_manage_ads', 'pages_manage_metadata', 'pages_read_engagement', 'pages_show_list', 'public_profile'];
  const slot = {
    scope_key: SCOPE, connection_ref: Admission.connectionRef(SCOPE), asset_ref: 'meta-enroll:' + SCOPE,
    clinic_ids: JSON.stringify([CLINIC]), app_id: APP, scopes: JSON.stringify(scopes),
    redirect_uri: 'https://app.example.invalid/oauth/meta/marketing/callback',
    expires_at: new Date(started + 86400000), state: 'active',
  };
  await models.MetaMarketingOAuthSlot.create(slot);
  const scope = require('../../services/metaMarketingOAuthScope.service').createScope({ models, sessions, now });
  const captured = await sql.transaction(transaction => scope.capture(input, transaction));
  const flowId = randomUUID();
  const credential = {
    versionId: flowId, digest: OAuth.hash('FICTITIOUS_NOVEL_CANDIDATE'), appId: APP, subjectId: SUBJECT, tokenType: 'USER',
    scopes, expiresAt: started + 3600000, dataAccessExpiresAt: null, granularScopes: [],
  };
  const flow = (await models.MetaMarketingOAuthRequest.create({
    ...slot, flow_id: flowId, state_hash: OAuth.hash(flowId), slot_digest: captured.slotDigest, scope_digest: captured.scopeDigest,
    actor_user_id: ACTOR, session_ref: input.sessionRef, session_expires_at: input.sessionExpiresAt,
    return_origin: 'https://app.example.invalid', requested_at: now(), expires_at: new Date(started + 600000),
    state: 'staged', candidate_metadata: JSON.stringify(credential), next_attempt_at: now(), completed_at: now(),
  })).get({ plain: true });
  const inventory = {
    flowId, candidateVersionId: flowId, candidateDigest: credential.digest, scopeKey: SCOPE, scopeDigest: flow.scope_digest,
    clinicSetDigest: OAuth.hash(slot.clinic_ids), observedAt: started, expiresAt: started + 300000,
    accessBlocked: true, availableKinds: Discovery.kinds(credential),
    assets: [ACCOUNT, EXTRA_ACCOUNT, PAGE].map(asset),
  };
  const oauth = { assets: async (_input, id) => { assert.equal(id, flowId); return { inventory }; } };
  const { createAuthority } = require('../../services/metaMarketingEnrollmentAuthority.service');
  const { createBindings } = require('../../services/metaMarketingEnrollmentBinding.service');
  const { createReview } = require('../../services/metaMarketingEnrollmentReview.service');
  const authority = createAuthority({ models, sessions, oauth, now, enabled: () => true });
  const bindings = createBindings({ models, sessions, authority, now });
  const review = createReview({ models, sessions, now });
  const observe = () => sql.transaction(transaction => review({ row: flow, inventory }, transaction));
  const reserve = refs => authority.reserve(input, flowId, refs);
  const committed = id => sql.transaction(transaction => bindings.committed(id, transaction));

  const { SETTING: permitName } = require('../../services/metaMarketingFirstEnrollmentAuthority.service');
  delete process.env[permitName];
  await assert.rejects(reserve(SELECTED), { code: 'meta_enrollment_assignment_review' });
  process.env[permitName] = JSON.stringify({
    clinicId: CLINIC, legacyGrantId: LEGACY_GRANT, legacyConnectionId: LEGACY_CONNECTION,
    canonicalConnectionId: CANONICAL_CONNECTION, appId: APP,
    adAccountId: ACCOUNT.split(':')[1], pageId: PAGE.split(':')[1],
  });

  emailVerified = false;
  await assert.rejects(reserve(SELECTED), { code: 'auth_email_verification_required' });
  emailVerified = true;
  const observed = await observe();
  assert.equal(observed.scopeStatus, 'clear');
  assert.equal(observed.reservationMade, false);
  assert.deepEqual(observed.assets.filter(row => row.status === 'clear').map(row => row.assetRef), SELECTED);
  await assert.rejects(reserve([ACCOUNT, 'meta-facebook_page:99499']), { code: 'meta_enrollment_invalid' });
  await assert.rejects(reserve([EXTRA_ACCOUNT, PAGE]), { code: 'meta_enrollment_assignment_review' });
  await assert.rejects(reserve([ACCOUNT]), { code: 'meta_enrollment_assignment_review' });
  assert.equal(await models.MetaMarketingEnrollmentRequest.count(), 0);
  assert.equal(await models.MetaMarketingEnrollmentClaim.count(), 0);
  assert.equal(await models.MetaMarketingEnrollmentIdentity.count(), 0);
  assert.deepEqual(await snapshotLegacy(), legacyBefore);

  const withdrawalData = {
    tuple_hash: OAuth.hash('FICTITIOUS_PRIOR_WITHDRAWAL'), connection_ref: 'connection:other-fixture', asset_ref: PAGE,
    tenant_clinic_id: CLINIC + 1, meta_connection_id: LEGACY_CONNECTION + 1, meta_user_id: '99112',
    app_id: APP, parent_page_id: null, scope_key: 'clinic:' + (CLINIC + 1), clinic_ids: JSON.stringify([CLINIC + 1]),
    mapping_ids: '[]', request_id: randomUUID(), actor_user_id: ACTOR, requested_at: now(), next_attempt_at: now(), state: 'confirmed',
  };
  const withdrawal = await models.MetaMarketingBrokerRevocation.create(withdrawalData);
  try {
    await assert.rejects(reserve(SELECTED), { code: 'meta_enrollment_asset_revoked' });
    assert.equal(await models.MetaMarketingBrokerRevocation.count(), 1);
  } finally {
    await withdrawal.destroy();
  }
  report.checks.push('MFA, exact two-asset selection, foreign assets and a prior revocation checked without mutating WhatsApp or leaving partial claims');

  await models.MetaMarketingEnrollmentIdentity.create({
    meta_user_id: SUBJECT, app_id: APP, meta_connection_id: CANONICAL_CONNECTION, created_at: now(),
  });
  const reserved = Enrollment.request(await reserve(SELECTED));
  assert.equal(reserved.meta_connection_id, CANONICAL_CONNECTION);
  const canonical = await models.MetaConnection.findByPk(reserved.meta_connection_id, { raw: true });
  assert.equal(canonical.metaUserId, SUBJECT);
  assert.equal(canonical.broker_app_id, APP);
  assert.ok(canonical.credentials_external);
  assert.equal(canonical.accessToken, null);
  assert.equal(await models.MetaMarketingEnrollmentIdentity.count(), 1);
  assert.deepEqual(reserved.selected.map(row => row.assetRef), SELECTED);
  const id = reserved.enrollment_id;
  const request = await models.MetaMarketingEnrollmentRequest.findByPk(id);
  await request.update({
    state: 'activate_pending', selection_digest: Enrollment.hash('FICTITIOUS_APPLIED_SELECTION'),
    prepared_at: now(), lease_token: randomUUID(), lease_until: new Date(started + 120000),
  });
  const pending = Enrollment.request(request.get({ plain: true }));
  const receipt = {
    enrollmentId: id, flowId, scopeKey: SCOPE, scopeDigest: pending.scope_digest, candidateDigest: pending.candidate_digest,
    selectionDigest: pending.selection_digest, clinicSetDigest: OAuth.hash(pending.clinic_ids),
    assets: pending.selected, status: 'active', accessBlocked: false, preparedAt: started, activatedAt: started,
  };
  const active = await sql.transaction(transaction => bindings.activate(pending, receipt, transaction));
  assert.equal(active.state, 'active');
  assert.deepEqual(await snapshotLegacy(), legacyBefore);
  assert.equal(await models.ClinicMetaAsset.count(), 4);
  assert.equal(await models.MetaMarketingBrokerBinding.count({ where: { enrollment_id: id } }), 2);

  delete process.env[permitName];
  const accepted = await committed(id);
  assert.equal(accepted.marketingOnly, true);
  assert.deepEqual(accepted.clinicIds, [CLINIC]);
  const { createMetaMarketingBrokerScope, createMetaMarketingScopeRepository, createMetaMarketingLeadIngressScopeRepository } =
    require('../../services/metaMarketingBrokerScope.service');
  for (const repository of [createMetaMarketingScopeRepository, createMetaMarketingLeadIngressScopeRepository]) {
    const reader = createMetaMarketingBrokerScope({ ...repository(() => models), enabled: () => true });
    for (const mappingId of active.mappingIds) {
      const context = await reader.prepare(mappingId);
      const access = await reader.assertContext(context);
      assert.equal(access.scopeKey, SCOPE);
      assert.equal(access.assetRef === ACCOUNT || access.assetRef === PAGE, true);
    }
    await assert.rejects(reader.prepare(LEGACY_PHONE), { code: 'meta_broker_binding_invalid' });
  }
  await models.MetaMarketingBrokerRevocation.create(withdrawalData);
  await assert.rejects(committed(id), { code: 'meta_enrollment_asset_revoked' });
  assert.equal(await models.MetaMarketingBrokerRevocation.count(), 1);
  await models.MetaMarketingBrokerRevocation.destroy({ where: { tuple_hash: withdrawalData.tuple_hash } });
  await models.MetaMarketingEnrollmentRequest.update({ assignment_digest: '0'.repeat(64) }, { where: { enrollment_id: id } });
  await assert.rejects(committed(id));
  assert.deepEqual(await snapshotLegacy(), legacyBefore);
  report.checks.push('Real reservation and activation persist only broker Marketing grants; normal and Lead-ingress readers use durable certification once the pilot permit is closed');
  report.checks.push('A later revocation or modified certificate fails closed; legacy WhatsApp connection, grant, phone and business account rows remain unchanged');
}).catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
