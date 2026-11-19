'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/business_profile_first_profile.fixture');
const { createFirstProfileService, inspectContext, status } = require('../../services/businessProfileFirstProfile.service');

test('first-profile inventory defaults OFF and performs no metadata, secret or provider work', async () => {
  const f = fixture(); f.control.enabled = false;
  assert.deepEqual(await f.service.preflight(f.input), { enabled: false, clinicId: 123, canDiscover: false, canPrepare: false, reason: 'gbp_first_profile_disabled' });
  await assert.rejects(f.service.candidates(f.input), { code: 'gbp_first_profile_disabled' });
  assert.equal(f.calls.length, 0); assert.equal(f.commands.length, 0);
  const defaultService = createFirstProfileService({ models: () => assert.fail('default gate must not load models') });
  const old = process.env.GOOGLE_BUSINESS_PROFILE_FIRST_PROFILE_ENABLED;
  try { delete process.env.GOOGLE_BUSINESS_PROFILE_FIRST_PROFILE_ENABLED; assert.equal((await defaultService.preflight(f.input)).enabled, false); }
  finally { if (old === undefined) delete process.env.GOOGLE_BUSINESS_PROFILE_FIRST_PROFILE_ENABLED; else process.env.GOOGLE_BUSINESS_PROFILE_FIRST_PROFILE_ENABLED = old; }
});
test('first-profile preflight uses real session/marketing authority and never creates local permissions', async () => {
  const f = fixture(), before = structuredClone(f.state);
  const result = await f.service.preflight(f.input);
  assert.equal(result.enabled, true); assert.equal(result.canDiscover, true); assert.equal(result.canPrepare, true);
  assert.match(result.sourceFingerprint, /^[a-f0-9]{64}$/); assert.equal(result.reason, 'owner_scope_required');
  assert.equal(f.commands.length, 0); assert.deepEqual(f.state, before);
  assert(f.calls.some(call => call.name === 'connectionCustody'));
  assert(f.calls.some(call => call.name === 'UsuarioClinica'));
});
test('catalogue is bound to one derived Owner scope and returns no credentials, authority or preparation intent', async () => {
  const f = fixture(), before = structuredClone(f.state), result = await f.service.candidates(f.input);
  assert.equal(result.inventory_mode, 'broker_first_profile_candidates'); assert.equal(result.canPrepare, true);
  assert.deepEqual(result.accounts, [{ accountName: 'accounts/100', accountDisplayName: 'FICTITIOUS_ACCOUNT',
    locations: [{ locationId: 'locations/300', name: 'FICTITIOUS_PROFILE_300', address: 'FICTITIOUS_ADDRESS' }] }]);
  assert.equal(f.commands.length, 1);
  assert.deepEqual({ ...f.commands[0], requestId: 'omitted' }, { requestId: 'omitted', operation: 'google.business_profile.enrollment.discover.v1',
    tenantRef: 'clinic:123', connectionRef: 'connection:test', assetRef: 'gbp-enroll:clinic:123', payload: { pageToken: null } });
  assert.deepEqual(f.state, before);
  for (const field of ['google_user_id', 'connection_ref', 'sessionRef', 'secret', 'scope_ref', 'accessToken']) assert(!JSON.stringify(result).includes(field));
});
test('no absent local scope can substitute a global inventory after Owner denial', async () => {
  for (const code of ['scope_denied', 'operation_denied', 'oauth_identity_mismatch', 'asset_revoked', 'credential_revoked']) {
    const f = fixture({ transport: { async execute() { throw Object.assign(Error(code), { code }); } } }), before = structuredClone(f.state);
    await assert.rejects(f.service.candidates(f.input), { code }); assert.equal(f.commands.length, 1); assert.deepEqual(f.state, before);
  }
  await assert.rejects(inspectContext({}), { code: 'gbp_association_invalid' });
  await assert.rejects(fixture().client.discoverFirstProfile({ clinica_id: 123, connection_ref: 'connection:test', scope_ref: 'gbp-enroll:clinic:123' }), { code: 'gbp_association_invalid' });
});
test('revoked overrides, lost permission, unconfirmed identity and SQL credentials deny before Owner access', async () => {
  const mutations = [
    f => f.state.GoogleConnectionAssignment.push({ scopeKey: 'clinic:123', assignmentScope: 'clinic', clinicaId: 123, grupoClinicaId: null, googleConnectionId: 81, status: 'disconnected' }),
    f => { f.state.UsuarioClinica[0].rol_clinica = 'paciente'; },
    f => { f.state.GoogleOAuthBrokerBinding[0].confirmed_at = null; },
    f => { f.state.GoogleConnection[0].credentials_external = 0; },
    f => { f.state.GoogleConnection[0].googleUserId = 'other-subject'; },
    f => { f.control.session = false; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); const before = structuredClone(f.state);
    await assert.rejects(f.service.candidates(f.input)); assert.equal(f.commands.length, 0); assert.deepEqual(f.state, before);
  }
});
test('existing or blocked scope, inactive history, generations, attempts and withdrawals cannot become a first registration', async () => {
  const rows = [
    ['BusinessProfileAssociationScope', { scope_key: 'clinic:123', state: 'blocked' }],
    ['BusinessProfileAssociationScope', { scope_key: 'clinic:123', state: 'active' }],
    ['ClinicBusinessLocation', { id: 1, clinica_id: 123, is_active: false }],
    ['BusinessProfileBrokerBinding', { clinica_id: 123, state: 'retired' }],
    ['BusinessProfileBrokerBindingGeneration', { clinica_id: 123, state: 'retired' }],
    ['BusinessProfileAssociationRequest', { clinica_id: 123, state: 'cancelled' }],
    ['BusinessProfileBrokerRevocation', { clinica_id: 123, external_location_id: '300', state: 'confirmed' }],
  ];
  for (const [name, row] of rows) {
    const f = fixture(); f.state[name].push(row); const before = structuredClone(f.state);
    await assert.rejects(f.service.candidates(f.input)); assert.equal(f.commands.length, 0); assert.deepEqual(f.state, before);
  }
});
test('an inherited group profile or explicit share cannot be overwritten through first-profile discovery', async () => {
  for (const mutate of [f => { f.state.GrupoClinica[0].business_profile_assignment_mode = 'group'; },
    f => f.state.GroupAssetClinicAssignment.push({ assetType: 'google.business_profile', assetId: 999, clinicaId: 123, grupoClinicaId: 9 })]) {
    const f = fixture(); mutate(f); await assert.rejects(f.service.candidates(f.input), { code: 'gbp_association_inherited_asset' }); assert.equal(f.commands.length, 0);
  }
});
test('authority changes and expiration during provider I/O discard the catalogue without persisting anything', async () => {
  for (const mutate of [f => { f.control.enabled = false; }, f => { f.control.session = false; },
    f => { f.state.GoogleConnectionAssignment[0].status = 'revoked'; }, f => { f.state.Clinica[0].grupoClinicaId = 10; },
    f => { f.clock.at = f.input.sessionExpiresAt; }, f => { f.state.GoogleOAuthBrokerBinding[0].confirmed_at = new Date(f.clock.at + 1); }]) {
    const f = fixture(); f.control.after = () => mutate(f);
    await assert.rejects(f.service.candidates(f.input)); assert.equal(f.state.BusinessProfileAssociationScope.length, 0); assert.equal(f.state.ClinicBusinessLocation.length, 0);
  }
});
test('a slow metadata recheck cannot dispatch to Owner after the catalogue deadline', async () => {
  const f = fixture(), model = f.models.BusinessProfileAssociationRequest, lookup = model.findOne; let reads = 0;
  model.findOne = async function(options) {
    const value = await lookup.call(this, options);
    if (++reads === 2) f.clock.at += 60001;
    return value;
  };
  await assert.rejects(f.service.candidates(f.input), { code: 'provider_timeout' }); assert.equal(f.commands.length, 0);
});
test('global collision projection is non-locking and excludes owned, historical, withdrawn and reassociated targets', async () => {
  for (const [name, row] of [
    ['ClinicBusinessLocation', { id: 1, clinica_id: 999, location_id: 'accounts/777/locations/300', is_active: false }],
    ['BusinessProfileBrokerBinding', { clinica_id: 999, external_location_id: '300', state: 'retired' }],
    ['BusinessProfileBrokerBindingGeneration', { clinica_id: 999, external_location_id: '300', state: 'retired' }],
    ['BusinessProfileBrokerRevocation', { clinica_id: 999, external_location_id: '300', state: 'confirmed' }],
  ]) {
    const f = fixture(); f.state[name].push(row); const before = structuredClone(f.state);
    assert.deepEqual((await f.service.candidates(f.input)).accounts, []); assert.deepEqual(f.state, before);
    const reads = f.calls.filter(call => call.method === 'findAll' && ['ClinicBusinessLocation', 'BusinessProfileBrokerBinding', 'BusinessProfileBrokerBindingGeneration', 'BusinessProfileBrokerRevocation'].includes(call.name));
    assert(reads.length >= 4); assert(reads.every(call => !Object.hasOwn(call.options, 'lock') && call.options.limit === 1001));
  }
});
test('malformed, replayed, duplicated and cyclic provider catalogues fail closed', async () => {
  for (const mutate of [(r) => ({ ...r, requestId: 'other' }), r => ({ ...r, replayed: true }),
    r => ({ ...r, data: { ...r.data, accessToken: 'FICTITIOUS' } }),
    r => ({ ...r, data: { locations: [...r.data.locations, ...r.data.locations], nextPageToken: null } }),
    r => ({ ...r, data: { ...r.data, nextPageToken: 'a'.repeat(43) } })]) {
    const f = fixture(); f.control.reply = mutate;
    await assert.rejects(f.service.candidates(f.input), { code: 'broker_response_invalid' });
  }
  assert.equal(status({ code: 'gbp_association_own_session_required' }), 403);
  assert.equal(status({ code: 'gbp_association_session_required' }), 401);
});
