'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const C = require('../../services/googleAdsEnrollment.contract');
const { createGoogleAdsEnrollmentScope } = require('../../services/googleAdsEnrollmentScope.service');
const { createGoogleAdsEnrollmentClient } = require('../../services/googleAdsEnrollmentClient.service');
function fixture() {
  const at = new Date('2026-09-13T12:00:00Z').getTime(); const state = { at, allowed: true, enabled: true, calls: [], controls: [],
    scope: { scope_key: 'group:5', google_connection_id: 2, google_user_id: 'fictitious-subject', connection_ref: 'google:ads:test',
      asset_ref: 'ads-enroll:group:5', tenant_clinic_id: 59, root_customer_id: '9876543210', login_customer_id: null, state: 'active' },
    clinics: [{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }],
    grants: [{ id: 1, assignmentScope: 'group', clinicaId: null, grupoClinicaId: 5, googleConnectionId: 2, status: 'active' }],
    connection: { id: 2, googleUserId: 'fictitious-subject', credentials_external: 1 },
    candidate: { mappings: [], bindings: [], revocations: [], requests: [] }, onSend: null, response: null };
  const input = { scopeKey: 'group:5', connectionId: 2, clinicIds: [59, 71], actorId: 9, sessionRef: randomUUID(), sessionExpiresAt: at + 3600000 };
  const scope = createGoogleAdsEnrollmentScope({ now: () => state.at, enabled: () => state.enabled,
    authorize: async () => { await state.onAuthorize?.(); return state.allowed; },
    snapshot: async () => structuredClone({ scope: state.scope, clinics: state.clinics, grants: state.grants, connection: state.connection }),
    candidate: async (_id, { transaction }) => { assert.equal(transaction.LOCK.UPDATE, 'UPDATE'); return structuredClone(state.candidate); } });
  const send = async (command, control) => {
    (control ? state.controls : state.calls).push(structuredClone(command)); await state.onSend?.();
    if (state.response) return state.response(command);
    if (command.operation === C.broker.OPERATIONS.discover) return { requestId: command.requestId, replayed: false,
      data: { accounts: [{ id: '1234567890', manager: false, currencyCode: 'EUR', timeZone: 'Europe/Madrid', descriptiveName: 'Fictitious account', status: 'ENABLED' }], nextPageToken: null } };
    return { requestId: command.requestId, replayed: false, data: { enrollmentId: command.payload.enrollmentId,
      assetRef: 'ads:' + command.payload.customerId, scopeRef: command.assetRef, clinicCount: command.payload.clinicCount,
      clinicSetDigest: command.payload.clinicSetDigest, state: control ? 'revoked' : command.operation === C.broker.OPERATIONS.activate ? 'active' : 'prepared',
      ...(control ? { accessBlocked: true } : {}) } };
  };
  const client = createGoogleAdsEnrollmentClient({ scope, now: () => state.at,
    client: { execute: command => send(command, false) }, controlClient: { execute: command => send(command, true) } });
  const row = async handle => {
    const saved = await scope.assert(handle);
    return { enrollment_id: randomUUID(), scope_key: saved.scope_key, google_connection_id: 2, google_user_id: saved.google_user_id,
      connection_ref: saved.connection_ref, scope_ref: saved.asset_ref, tenant_clinic_id: 59, customer_id: '1234567890',
      login_customer_id: saved.root_customer_id, clinic_ids: JSON.stringify(saved.clinicIds), clinic_count: saved.clinicIds.length,
      clinic_digest: saved.clinicDigest, scope_digest: saved.scopeDigest, mapping_id: null, actor_user_id: input.actorId, session_ref: input.sessionRef,
      session_expires_at: new Date(input.sessionExpiresAt), prepare_request_id: randomUUID(), activate_request_id: randomUUID(), revoke_request_id: randomUUID(),
      state: 'prepare_pending', requested_at: new Date(at), updated_at: new Date(at), next_attempt_at: new Date(at), attempts: 0,
      lease_token: null, lease_until: null, last_error: null };
  };
  return { state, scope, client, input, row, transaction: { LOCK: { UPDATE: 'UPDATE' } } };
}
test('enrollment captures an explicit opaque group context, immutable identity and the original clinic set', async () => {
  const f = fixture(); const context = await f.scope.capture(f.input); f.input.clinicIds.push(999);
  const saved = await f.scope.assert(context); assert.deepEqual(saved.clinicIds, [59,71]); assert.equal(saved.tenant_clinic_id, 59);
  assert.deepEqual(context, {}); await assert.rejects(f.scope.assert({}), { code: 'google_ads_enrollment_invalid' });
  saved.clinicIds.push(999); assert.deepEqual((await f.scope.assert(context)).clinicIds, [59,71]);
  f.scope.release(context); await assert.rejects(f.scope.assert(context));
});
test('foreign clinics, group additions, primary grant changes and credential residency close the captured scope', async () => {
  for (const change of [f => f.state.clinics.push({ id_clinica: 99, grupoClinicaId: 5 }),
    f => { f.state.grants[0].googleConnectionId = 88; }, f => { f.state.grants[0].status = 'disconnected'; },
    f => f.state.grants.push({ id: 2, assignmentScope: 'clinic', clinicaId: 71, grupoClinicaId: null, googleConnectionId: 88, status: 'active' }),
    f => { f.state.scope.tenant_clinic_id = 999; }, f => { f.state.connection.credentials_external = 0; },
    f => { f.state.scope.connection_ref = 'another:connection'; }, f => { f.state.allowed = false; }]) {
    const f = fixture(); const context = await f.scope.capture(f.input); change(f); await assert.rejects(f.scope.assert(context));
    assert.equal(f.state.calls.length, 0);
  }
});
test('eligibility rejects every existing alias, including inactive/group-primary mappings and surviving independent histories', async () => {
  for (const key of ['mappings','bindings','revocations','requests']) {
    const f = fixture(); const context = await f.scope.capture(f.input);
    f.state.candidate[key] = [key === 'requests' ? { enrollment_id: randomUUID(), state: 'revoked' }
      : key === 'mappings' ? { id: 111, assignmentScope: 'group', grupoClinicaId: 999, isActive: false } : { customer_id: '1234567890' }];
    await assert.rejects(f.scope.assertNewCustomer(context, '1234567890', { transaction: f.transaction }));
  }
  const f = fixture(); const context = await f.scope.capture(f.input);
  await assert.rejects(f.scope.assertNewCustomer(context, '1234567890'));
  await f.scope.assertNewCustomer(context, '1234567890', { transaction: f.transaction });
});
test('restore preserves the original intent scope and session; it cannot absorb wider membership or changed references', async () => {
  const f = fixture(); const context = await f.scope.capture(f.input); const row = await f.row(context);
  assert.ok(await f.scope.restore(row));
  await assert.rejects(f.scope.restore({ ...row, connection_ref: 'another:connection' }));
  f.state.clinics.push({ id_clinica: 99, grupoClinicaId: 5 }); await assert.rejects(f.scope.restore(row));
  f.state.clinics.pop(); f.state.at = f.input.sessionExpiresAt; await assert.rejects(f.scope.restore(row), { code: 'google_discovery_session_required' });
});
test('typed client projects discovery and signs preparation using only the persisted scope and request IDs', async () => {
  const f = fixture(); const context = await f.scope.capture(f.input); const row = await f.row(context);
  const discovery = await f.client.discover(context); assert.equal(discovery.accounts[0].loginCustomerId, '9876543210');
  assert.equal(discovery.accounts[0].broker_read_connection_ref, undefined);
  const prepared = await f.client.prepare(row, context); assert.equal(prepared.state, 'prepared');
  const request = f.state.calls[1]; assert.equal(request.requestId, row.prepare_request_id);
  assert.equal(request.assetRef, 'ads-enroll:group:5'); assert.equal(request.tenantRef, 'clinic:59');
  assert.deepEqual(request.payload, { enrollmentId: row.enrollment_id, customerId: '1234567890', clinicCount: 2, clinicSetDigest: C.digest([59,71]) });
  await assert.rejects(f.client.activate(row, context), { code: 'google_ads_enrollment_scope_conflict' });
  row.state = 'activate_pending'; row.mapping_id = 11;
  assert.equal((await f.client.activate(row, context)).state, 'active');
  assert.equal(f.state.calls[2].requestId, row.activate_request_id); assert.equal(f.state.controls.length, 0);
});
test('permission loss after an await or immediately before dispatch rejects the whole response', async () => {
  const f = fixture(); const context = await f.scope.capture(f.input); const row = await f.row(context);
  await assert.rejects(f.client.prepare(row, context, { beforeExecute: async () => { f.state.allowed = false; } }), { code: 'google_discovery_scope_forbidden' });
  assert.equal(f.state.calls.length, 0); f.state.allowed = true;
  f.state.onSend = () => { f.state.allowed = false; };
  await assert.rejects(f.client.discover(context), { code: 'google_discovery_scope_forbidden' });
  assert.equal(f.state.calls.length, 1);
});
test('receipt mismatches, arbitrary fields and wrong status never confirm activation', async () => {
  for (const mutate of [r => { r.data.assetRef = 'ads:9999999999'; }, r => { r.data.scopeRef = 'ads-enroll:group:999'; },
    r => { r.data.state = 'prepared'; }, r => { r.data.clinicCount = 1; }, r => { r.data.rawToken = 'FICTITIOUS_SECRET'; }]) {
    const f = fixture(); const context = await f.scope.capture(f.input); const row = await f.row(context); row.state = 'activate_pending'; row.mapping_id = 11;
    f.state.response = command => { const result = { requestId: command.requestId, replayed: false,
      data: { enrollmentId: row.enrollment_id, assetRef: 'ads:' + row.customer_id, scopeRef: row.scope_ref,
        clinicCount: 2, clinicSetDigest: row.clinic_digest, state: 'active' } }; mutate(result); return result; };
    await assert.rejects(f.client.activate(row, context), { code: 'broker_response_invalid' });
  }
});
test('revocation has its own client and durable authorization check, and still works after the user session expires', async () => {
  const f = fixture(); const context = await f.scope.capture(f.input); const row = await f.row(context); f.state.at = f.input.sessionExpiresAt;
  await assert.rejects(f.client.revoke(row));
  row.state = 'revoke_pending';
  await assert.rejects(f.client.revoke(row, { beforeExecute: async () => false })); assert.equal(f.state.controls.length, 0);
  assert.equal((await f.client.revoke(row, { beforeExecute: async () => true })).state, 'revoked');
  assert.equal(f.state.controls[0].requestId, row.revoke_request_id); assert.equal(f.state.calls.length, 0);
});
test('either enrollment registry closes legacy ID/subject reuse and wins between metadata checks and credential SELECT', async () => {
  const { credentialsFixture } = require('./fixtures/google_legacy_credentials.fixture');
  for (const key of ['enrollmentScopes', 'enrollmentRequests']) {
    const f = credentialsFixture();
    f.state[key].push({ google_connection_id: 81, google_user_id: 'fictitious-subject' });
    await assert.rejects(f.credentials.load(81), { code: 'google_oauth_legacy_closed' });
    f.add(82, 'fictitious-subject'); await assert.rejects(f.credentials.load(82), { code: 'google_oauth_legacy_closed' });
    f.state.rows.delete(81); await assert.rejects(f.credentials.load(81), { code: 'google_oauth_legacy_closed' });
    assert.equal(f.state.tokenReads, 0);
    const g = credentialsFixture(); g.state.beforeLoad = () => g.state[key].push({ google_connection_id: 81, google_user_id: 'fictitious-subject' });
    await assert.rejects(g.credentials.load(81), { code: 'google_oauth_legacy_closed' }); assert.equal(g.state.loads, 0); assert.equal(g.state.tokenReads, 0);
  }
});
