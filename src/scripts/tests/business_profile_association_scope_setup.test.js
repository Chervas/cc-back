'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../services/googleOAuthCohort.contract');
const setup = require('../business-profile-association-scope');
const oauth = { google_user_id: '113861427645841982899', cohort: 'business_profile', google_connection_id: 23,
  connection_ref: 'fixture-gbp', asset_ref: 'gbp:103033606619897470399:11953590883489062999',
  clinica_id: 64, scope_key: 'connection:23', policy_version: C.POLICY, confirmed_at: '2026-01-01T00:00:00.000Z' };
const config = () => setup.configuration({ schema: 'clinicaclick-gbp-association-scope/1', clinicId: 1, connectionId: 23,
  googleUserId: oauth.google_user_id, connectionRef: oauth.connection_ref,
  accountIds: ['103033606619897470399'], locationIds: ['15765789532715328999'], expectedMappingId: 2,
  expectedAssetRef: 'gbp:103033606619897470399:2059408182723799199', oauthBindingDigest: C.digest(oauth) });
const snapshot = () => ({ oauth: { ...oauth }, clinic: { id_clinica: 1, grupoClinicaId: 28 },
  connection: { id: 23, googleUserId: oauth.google_user_id, credentials_external: 1 },
  assignments: [{ scopeKey: 'clinic:1', googleConnectionId: 23, status: 'active' }, { scopeKey: 'group:28', googleConnectionId: 23, status: 'active' }],
  mappings: [{ id: 2, clinica_id: 1, google_connection_id: 23, location_id: 'locations/2059408182723799199', is_active: 1,
    broker_read_connection_ref: oauth.connection_ref, broker_read_asset_ref: config().expectedAssetRef }],
  binding: { external_location_id: '2059408182723799199', state: 'active', clinica_id: 1, google_connection_id: 23,
    connection_ref: oauth.connection_ref, asset_ref: config().expectedAssetRef }, revocations: [], scope: null });
test('authority setup retains long Google IDs as exact strings without associating a mapping', () => {
  const c = config(), row = setup.validateSnapshot(c, snapshot());
  assert.deepEqual(row.location_ids, ['15765789532715328999']);
  assert.deepEqual(row.account_ids, ['103033606619897470399']);
  assert.equal(row.scope_key, 'clinic:1'); assert.equal(row.state, 'active');
  assert.equal(Object.hasOwn(row, 'mapping_id'), false);
  const bad = { ...c, locationIds: [Number(c.locationIds[0])] };
  assert.throws(() => setup.configuration(bad));
});
test('a disconnected direct override cannot inherit the active group assignment', () => {
  const s = snapshot(); s.assignments[0].status = 'disconnected';
  assert.throws(() => setup.validateSnapshot(config(), s), /assignment_changed/);
  s.assignments.shift(); assert.equal(setup.validateSnapshot(config(), s).clinica_id, 1);
});
test('identity, credential custody and original mapping are pinned independently', () => {
  for (const mutate of [s => { s.oauth.asset_ref = 'gbp:103033606619897470399:9'; }, s => { s.oauth.confirmed_at = null; },
    s => { s.connection.credentials_external = 0; }, s => { s.connection.googleUserId = '999'; },
    s => { s.mappings[0].id = 70; }, s => { s.mappings[0].broker_read_connection_ref = 'other'; },
    s => { s.mappings[0].location_id = 'locations/999'; }, s => { s.binding.state = 'retired'; },
    s => { s.binding.clinica_id = 70; }, s => { s.binding = null; },
    s => { s.mappings.push({ ...s.mappings[0], id: 3 }); }, s => { s.revocations.push({ external_location_id: '15765789532715328999' }); }]) {
    const s = snapshot(); mutate(s); assert.throws(() => setup.validateSnapshot(config(), s));
  }
});
test('setup never overwrites an existing authority; reconciliation only accepts the exact installed tuple', () => {
  const c = config(), s = snapshot(); s.scope = setup.desired(c);
  assert.throws(() => setup.validateSnapshot(c, s));
  assert.deepEqual(setup.validateSnapshot(c, s, true), s.scope);
  s.scope.location_ids = ['999']; assert.throws(() => setup.validateSnapshot(c, s, true));
});
test('first association requires absence of a current mapping and rejects unreviewed configuration fields', () => {
  const c = config(); c.expectedMappingId = null; c.expectedAssetRef = null;
  const s = snapshot(); assert.throws(() => setup.validateSnapshot(c, s));
  s.mappings = []; assert.equal(setup.validateSnapshot(c, s).scope_key, 'clinic:1');
  assert.throws(() => setup.configuration({ ...c, token: 'fictitious-secret' }));
  assert.throws(() => setup.configuration({ ...c, accountIds: ['1','1'] }));
});
