'use strict';
// Invoked only inside the enclosing owned --skip-networking InnoDB fixture.
// The real OAuth/Scope/Discovery/audit SQL runs; the owner below holds metadata
// only and has no provider transport, tokens, model bootstrap or environment.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

module.exports = async ({ models, sql, now, advance, report, baseline, untouched }) => {
  assert.equal(models.sequelize, sql);
  assert.equal(report.database, 'campaign_optimization_qa');
  assert(/^\/tmp\/cc-campaign-opt-mysql-[A-Za-z0-9]+$/.test(report.root));
  assert.equal(sql.options.dialectOptions.socketPath, path.join(report.root, 'mysql.sock'));
  assert(models.UsuarioClinica, 'The enclosing Business fixture supplies the owned membership table');
  const C = require('../../../services/metaMarketingOAuth.contract');
  const B = require('../../../../services/integrations-broker/src/meta-marketing-oauth-contract');
  const D = require('../../../../services/integrations-broker/src/meta-marketing-discovery-contract');
  const scopeKey = 'clinic:95', actorId = 99, appId = '1901', subjectId = '2901';
  const scopes = ['ads_management', 'ads_read', 'leads_retrieval', 'pages_manage_ads',
    'pages_manage_metadata', 'pages_read_engagement', 'pages_show_list', 'public_profile'];
  assert.equal(scopes.length, 8); assert(scopes.every(value => B.SCOPES.includes(value)));
  assert(!scopes.some(value => /instagram|whatsapp/.test(value)));

  // Compare every preexisting metadata row byte-for-byte, allowing additions
  // only in this clinic, its membership/slot, two OAuth journals and their audit.
  // Credential-bearing models use explicit metadata projections throughout.
  const names = ['Clinica', 'UsuarioClinica', 'GrupoClinica', 'MetaConnection', 'MetaConnectionAssignment',
    'ClinicMetaAsset', 'GroupAssetClinicAssignment', 'MetaScopeBlock', 'MetaMarketingBrokerBinding',
    'MetaMarketingBrokerRevocation', 'MetaMarketingOAuthSlot', 'MetaMarketingOAuthRequest',
    'MetaMarketingEnrollmentRequest', 'MetaMarketingEnrollmentClaim', 'MetaMarketingEnrollmentIdentity',
    'MetaMarketingRecovery', 'MetaMarketingBusinessHandover', 'MetaMarketingCredentialMaintenance',
    'MetaMarketingCredentialRenewal', 'MetaMarketingBusinessDrain', 'PlatformAuditEvent'];
  const projections = {
    MetaConnection: ['id', 'userId', 'metaUserId', 'broker_app_id', 'credentials_external', 'expiresAt', 'createdAt', 'updatedAt'],
    ClinicMetaAsset: ['id', 'metaConnectionId', 'assetType', 'metaAssetId', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'isActive', 'createdAt', 'updatedAt'],
  };
  const selected = names.filter(name => models[name]);
  const key = (name, row) => JSON.stringify(models[name].primaryKeyAttributes.map(field => row[field]));
  const snapshot = async () => {
    const result = new Map();
    for (const name of selected) {
      const model = models[name], attributes = projections[name]?.filter(field => model.rawAttributes[field]);
      const rows = await model.findAll({ raw: true, logging: false,
        ...(attributes ? { attributes } : {}), order: model.primaryKeyAttributes.map(field => [field, 'ASC']) });
      result.set(name, new Map(rows.map(row => [key(name, row), JSON.stringify(row)])));
    }
    return result;
  };
  const before = await snapshot(), rejectedBefore = report.rejected.length;
  assert.equal(await models.Clinica.count({ where: { id_clinica: 95 } }), 0);
  assert.equal(await models.MetaMarketingOAuthSlot.count({ where: { scope_key: scopeKey } }), 0);
  assert.equal(await models.MetaMarketingOAuthRequest.count({ where: { scope_key: scopeKey } }), 0);
  assert.equal(await models.MetaMarketingEnrollmentRequest.count({ where: { scope_key: scopeKey } }), 0);
  await models.Clinica.create({ id_clinica: 95, nombre_clinica: 'Fictitious ordinary OAuth clinic',
    grupoClinicaId: null, estado_clinica: true });
  const membership = await models.UsuarioClinica.create({ id_usuario: actorId, id_clinica: 95,
    rol_clinica: 'agencia', estado_invitacion: 'aceptada' });
  // Parent fixtures normally advance their shared clock. The small local clock
  // fallback keeps the two append-only requested_at values strictly ordered.
  let localClock = +now();
  const at = advance ? now : () => new Date(localClock);
  const tick = () => advance ? advance(1) : localClock++;
  const input = { scopeKey, actorId, sessionRef: randomUUID(), sessionExpiresAt: new Date(+at() + 7200000) };
  const slot = { scope_key: scopeKey, connection_ref: 'connection:ordinary-fixture-95', asset_ref: 'meta-enroll:' + scopeKey,
    app_id: appId, clinic_ids: '[95]', scopes: JSON.stringify(scopes),
    redirect_uri: 'https://app.example.invalid/oauth/meta/marketing/callback',
    expires_at: new Date(+at() + 86400000), state: 'active' };
  C.slot(slot); await models.MetaMarketingOAuthSlot.create(slot);

  let sessionValid = true, emailVerified = true, revokeWriteAfterInventory = false, authorizationChecks = 0;
  const sessions = { async verifyReference(reference, options) {
    authorizationChecks++;
    assert(options.transaction && !options.transaction.finished);
    assert.equal(options.requireEmail, true);
    if (!sessionValid || reference.userId !== actorId || reference.sessionRef !== input.sessionRef
      || +reference.expiresAt !== +input.sessionExpiresAt || +reference.expiresAt <= +at()) {
      throw Object.assign(Error('auth_invalid'), { code: 'auth_invalid' });
    }
    if (!emailVerified) throw Object.assign(Error('auth_email_verification_required'),
      { code: 'auth_email_verification_required', status: 403 });
  } };
  const assets = [
    { assetRef: 'meta-ad_account:3901', kind: 'ad_account', id: '3901', name: 'Fictitious ordinary account',
      parentPageId: null, accountStatus: 1, currency: 'EUR', timezone: 'Europe/Madrid' },
    { assetRef: 'meta-facebook_page:4901', kind: 'facebook_page', id: '4901', name: 'Fictitious ordinary Page', parentPageId: null },
  ];
  const calls = [], remote = new Map();
  const load = id => models.MetaMarketingOAuthRequest.findByPk(id, { raw: true, logging: false });
  const view = value => ({ flowId: value.row.flow_id, status: value.status, connectionRef: value.row.connection_ref,
    scopeKey: value.row.scope_key, expiresAt: +value.row.expires_at, accessBlocked: true, candidate: value.candidate });
  const client = { async execute(command, options) {
    assert(C.exact(command, 'requestId,operation,tenantRef,connectionRef,assetRef,payload'));
    assert(C.UUID.test(command.requestId));
    assert.equal(command.tenantRef, scopeKey); assert.equal(command.connectionRef, slot.connection_ref);
    assert.equal(command.assetRef, slot.asset_ref);
    const name = command.operation === D.OPERATION ? 'assets'
      : Object.keys(B.OPERATIONS).find(value => B.OPERATIONS[value] === command.operation);
    assert(name, 'The closed owner permits only the existing OAuth/Discovery ABI');
    if (name === 'assets') D.validate(command.payload); else B.validators[name](command.payload);
    assert.equal(options.timeoutMs, ['finish', 'assets'].includes(name) ? 30000 : 10000);
    const flowId = name === 'begin' ? command.requestId : command.payload.flowId;
    const row = await load(flowId); assert(row); assert.equal(row.scope_key, scopeKey);
    assert.equal(row.actor_user_id, actorId); assert.equal(row.app_id, appId); assert.equal(row.scopes, JSON.stringify(scopes));
    calls.push({ name, operation: command.operation, flowId, requestId: command.requestId });
    let value = remote.get(flowId), data;
    if (name === 'begin') {
      assert(!value); assert.equal(row.state, 'begin_pending');
      assert.equal(command.payload.scopeDigest, row.scope_digest);
      assert.equal(command.payload.clinicSetDigest, C.hash(row.clinic_ids));
      assert.equal(command.payload.expiresAt, +row.expires_at);
      value = { row, state: command.payload.state, status: 'awaiting', candidate: null }; remote.set(flowId, value);
      const params = new URLSearchParams({ client_id: row.app_id, redirect_uri: row.redirect_uri,
        response_type: 'code', scope: scopes.join(','), state: value.state });
      data = { flowId, authUrl: 'https://www.facebook.com/v24.0/dialog/oauth?' + params, expiresAt: +row.expires_at };
    } else {
      assert(value, 'No unbegun owner flow is accepted');
      if (name === 'finish') {
        assert.equal(value.status, 'awaiting'); assert.equal(row.state, 'processing');
        assert.equal(command.payload.state, value.state);
        assert.equal(row.code_digest, C.hash(command.payload.code));
        value.candidate = C.candidate({ versionId: flowId, digest: C.hash('FICTITIOUS_ORDINARY_METADATA_' + flowId),
          appId, subjectId, tokenType: 'USER', scopes: [...scopes], expiresAt: +at() + 7200000,
          dataAccessExpiresAt: null, granularScopes: [] }, row);
        value.status = 'staged'; data = view(value);
      } else if (name === 'abort') {
        value.status = 'aborted'; value.candidate = null; data = view(value);
      } else if (name === 'status') data = view(value);
      else {
        assert.equal(value.status, 'staged'); assert.equal(row.state, 'staged');
        assert.equal(command.payload.scopeDigest, row.scope_digest);
        data = { flowId, candidateVersionId: flowId, candidateDigest: value.candidate.digest,
          scopeDigest: row.scope_digest, scopeKey, clinicSetDigest: C.hash(row.clinic_ids),
          observedAt: +at(), expiresAt: +at() + 300000, accessBlocked: true,
          availableKinds: D.kinds(value.candidate), assets: structuredClone(assets) };
        if (revokeWriteAfterInventory) {
          revokeWriteAfterInventory = false;
          await membership.update({ rol_clinica: 'personaldeclinica' });
        }
      }
    }
    return { requestId: command.requestId, replayed: false, data: structuredClone(data) };
  } };
  const service = require('../../../services/metaMarketingOAuth.service').createService({ models, sessions, client,
    now: at, enabled: () => true, discoveryEnabled: () => true, workerEnabled: () => false,
    returnOrigin: 'https://app.example.invalid' });
  const assertNoCommands = async (work, expected) => {
    const count = calls.length, flows = await models.MetaMarketingOAuthRequest.count();
    await assert.rejects(work, expected);
    assert.equal(calls.length, count); assert.equal(await models.MetaMarketingOAuthRequest.count(), flows);
  };
  assert.deepEqual(await service.status(input), { enabled: true, available: true, status: 'none' });
  sessionValid = false;
  await assertNoCommands(() => service.begin(input), { code: 'meta_oauth_session_required', httpStatus: 401 });
  sessionValid = true; emailVerified = false;
  await assertNoCommands(() => service.begin(input), { code: 'auth_email_verification_required', httpStatus: 403 });
  emailVerified = true; await membership.update({ rol_clinica: 'personaldeclinica' });
  await assertNoCommands(() => service.begin(input), { code: 'meta_oauth_scope_forbidden', httpStatus: 403 });
  await membership.update({ rol_clinica: 'agencia', estado_invitacion: 'pendiente' });
  await assertNoCommands(() => service.begin(input), { code: 'meta_oauth_scope_forbidden', httpStatus: 403 });
  await membership.update({ estado_invitacion: 'aceptada' });

  tick(); const first = await service.begin(input), firstState = new URL(first.authUrl).searchParams.get('state');
  assert.equal(first.status, 'awaiting'); assert.equal(first.connected, false); assert.equal(first.pending, true);
  assert.equal((await service.status(input)).available, false);
  await assertNoCommands(() => service.begin(input), { code: 'meta_oauth_busy', httpStatus: 409 });
  assert.equal((await service.reconcile(input, first.requestId)).status, 'awaiting');
  const code = 'FICTITIOUS_ORDINARY_CODE_' + first.requestId;
  assert.deepEqual(await service.callback({ state: firstState, code }),
    { returnOrigin: 'https://app.example.invalid', requestId: first.requestId });
  let staged = await load(first.requestId); assert.equal(staged.state, 'staged'); assert(staged.candidate_metadata);
  assert.equal(staged.code_digest, C.hash(code)); assert.equal(staged.lease_token, null); assert.equal(staged.last_error, null);
  await service.callback({ state: firstState, code });
  assert.equal((await service.reconcile(input, first.requestId)).status, 'staged');
  assert.equal(calls.filter(value => value.name === 'finish').length, 1, 'Callback replay never exchanges the code twice');
  emailVerified = false;
  await assertNoCommands(() => service.assets(input, first.requestId), { code: 'auth_email_verification_required', httpStatus: 403 });
  emailVerified = true;
  const listed = await service.assets(input, first.requestId);
  assert.equal(listed.status, 'staged'); assert.equal(listed.connected, false); assert.equal(listed.candidateReady, true);
  assert.deepEqual(listed.inventory.assets, assets); assert.deepEqual(listed.inventory.availableKinds, ['ad_account', 'facebook_page']);
  assert.equal(listed.assignmentReview.reservationMade, false); assert.equal(listed.assignmentReview.scopeStatus, 'clear');
  assert.deepEqual(listed.assignmentReview.scopeReasons, []); assert(listed.assignmentReview.assets.every(value => value.status === 'clear'));
  revokeWriteAfterInventory = true;
  await assert.rejects(() => service.assets(input, first.requestId), { code: 'meta_oauth_scope_forbidden', httpStatus: 403 });
  await membership.update({ rol_clinica: 'agencia' });
  assert.equal((await load(first.requestId)).state, 'staged', 'Inventory denial does not activate or replace the candidate');
  const cancelled = await service.cancel(input, first.requestId);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cancellationConfirmed, true);
  await service.cancel(input, first.requestId);
  assert.equal((await service.status(input)).available, true);

  tick(); const second = await service.begin(input), secondState = new URL(second.authUrl).searchParams.get('state');
  assert.notEqual(second.requestId, first.requestId); assert.equal(second.status, 'awaiting');
  assert.deepEqual(await service.callback({ state: secondState, denied: true }),
    { returnOrigin: 'https://app.example.invalid', requestId: second.requestId });
  const denied = await load(second.requestId);
  assert.equal(denied.state, 'cancelled'); assert.equal(denied.candidate_metadata, null); assert.equal(denied.code_digest, null);
  assert.equal(calls.filter(value => value.name === 'finish' && value.flowId === second.requestId).length, 0);
  const final = await service.status(input); assert.equal(final.requestId, second.requestId);
  assert.equal(final.available, true); assert.equal(final.status, 'cancelled'); assert.equal(final.connected, false);
  const history = await models.MetaMarketingOAuthRequest.findAll({ where: { scope_key: scopeKey }, raw: true,
    order: [['requested_at', 'ASC'], ['flow_id', 'ASC']] });
  assert.deepEqual(history.map(row => row.flow_id), [first.requestId, second.requestId]);
  assert(history.every(row => row.state === 'cancelled' && row.completed_at instanceof Date && row.clinic_ids === '[95]'));
  assert.equal(history[0].candidate_metadata, staged.candidate_metadata, 'Cancelled journals retain their metadata history');
  assert(!JSON.stringify(history).includes(code)); assert(!JSON.stringify(history).includes(firstState));
  assert.equal(await models.MetaMarketingEnrollmentRequest.count({ where: { scope_key: scopeKey } }), 0);
  const counts = Object.fromEntries(['begin', 'finish', 'status', 'assets', 'abort'].map(name => [name, calls.filter(value => value.name === name).length]));
  assert.deepEqual(counts, { begin: 2, finish: 1, status: 3, assets: 2, abort: 2 });
  const after = await snapshot(), additions = {};
  for (const name of selected) {
    for (const [id, value] of before.get(name)) assert.equal(after.get(name).get(id), value, name + ' preexisting metadata row changed');
    additions[name] = [...after.get(name).keys()].filter(id => !before.get(name).has(id)).length;
    if (!['Clinica', 'UsuarioClinica', 'MetaMarketingOAuthSlot', 'MetaMarketingOAuthRequest', 'PlatformAuditEvent'].includes(name)) {
      assert.equal(additions[name], 0, name + ' received an unexpected ordinary OAuth write');
    }
  }
  assert.equal(additions.Clinica, 1); assert.equal(additions.UsuarioClinica, 1);
  assert.equal(additions.MetaMarketingOAuthSlot, 1); assert.equal(additions.MetaMarketingOAuthRequest, 2);
  const auditRows = [...after.get('PlatformAuditEvent')].filter(([id]) => !before.get('PlatformAuditEvent').has(id)).map(([, value]) => JSON.parse(value));
  const events = auditRows.map(row => JSON.parse(row.body));
  assert.equal(events.length, 11);
  assert(events.every(value => value.scope.type === 'clinic' && value.scope.id === '95'
    && value.connectionRef === slot.connection_ref && value.clinicCount === 1));
  assert.equal(events.filter(value => value.reason === 'authorization_requested').length, 2);
  assert.equal(events.filter(value => value.reason === 'credentials_staged').length, 1);
  assert.equal(events.filter(value => value.reason === 'authorization_cancel_requested').length, 2);
  assert.equal(events.filter(value => value.reason === 'authorization_cancelled').length, 2);
  assert.equal(events.filter(value => value.reason === 'inventory_verified').length, 1);
  assert.equal(events.filter(value => value.reason === 'access_changed').length, 1);
  assert.equal(report.rejected.length, rejectedBefore, 'No denied external socket/provider attempt occurred');
  if (baseline) assert.equal(await baseline(), untouched);
  report.ordinaryOAuth = { scopeKey, actorId, scopeCount: scopes.length, tokenType: 'USER', flowHistory: history.length,
    states: history.map(row => row.state), commands: counts, authorizationChecks, inventoryAssetCount: listed.inventory.assets.length,
    retainedAuditEvents: events.length, preexistingMetadataRows: [...before.values()].reduce((sum, rows) => sum + rows.size, 0),
    postIoWriteRevalidation: true, providerRequests: 0 };
  report.checks.push('Actual ordinary USER8 clinic95 OAuth uses managed verified-email sessions and agency marketing WRITE; real SQL status/begin/callback/reconcile/assets/cancel retain two journals, validate closed inventory, reject access lost after I/O and denied second consent without credential exchange, preserving existing Business/Recovery/mapping/WhatsApp metadata');
};
