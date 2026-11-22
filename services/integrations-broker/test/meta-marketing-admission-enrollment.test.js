'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const C = require('../src/meta-marketing-oauth-contract');
const D = require('../src/meta-marketing-discovery-contract');
const E = require('../src/meta-marketing-enrollment-contract');
const R = require('../src/meta-marketing-credential-renewal-contract');
const { admissionFixture } = require('./meta-marketing-admission-fixture.cjs');

async function candidate(t, { permitEnrollment = true, credentialEpochs = false } = {}) {
  const fixture = admissionFixture(t, {
    discovery: true,
    discoveryScopeKeys: ['clinic:123'],
    enrollment: true,
    enrollmentScopeKeys: permitEnrollment ? ['clinic:123'] : [],
    credentialEpochs,
  });
  const prepared = fixture.command();
  await fixture.prepare(prepared);
  const begin = fixture.beginCommand(prepared);
  await fixture.execute(begin);
  const send = (operation, payload, handle = fixture.current, control = false) =>
    fixture.execute({ ...prepared, requestId: randomUUID(), operation, payload }, handle, control);
  const staged = await send(C.OPERATIONS.finish, {
    flowId: begin.requestId,
    state: begin.payload.state,
    code: 'FICTITIOUS_DYNAMIC_SELECTION_CODE',
  });
  const flowId = begin.requestId;
  const scopeDigest = begin.payload.scopeDigest;
  const discover = () => send(D.OPERATION, { flowId, scopeDigest });
  const selection = {
    enrollmentId: randomUUID(),
    flowId,
    scopeDigest,
    candidateDigest: staged.data.candidate.digest,
    assetRefs: ['meta-ad_account:301', 'meta-facebook_page:401'],
  };
  return { fixture, prepared, send, discover, selection };
}

test('opted-in first authorization can prepare and confirm exactly its selected assets', async t => {
  const { fixture, prepared, send, discover, selection } = await candidate(t);
  const original = JSON.stringify(fixture.current.broker.policy);
  const catalog = (await discover()).data;
  for (const assetRef of selection.assetRefs) assert(catalog.assets.some(asset => asset.assetRef === assetRef));
  await assert.rejects(send(E.OPERATIONS.prepare, { ...selection, assetRefs: ['meta-ad_account:999'] }), { code: 'scope_denied' });
  const staged = (await send(E.OPERATIONS.prepare, selection)).data;
  assert.equal(staged.status, 'prepared');
  assert.equal(staged.accessBlocked, true);
  const confirmation = {
    enrollmentId: selection.enrollmentId,
    scopeDigest: selection.scopeDigest,
    selectionDigest: staged.selectionDigest,
  };
  const active = (await send(E.OPERATIONS.activate, confirmation)).data;
  assert.equal(active.status, 'active');
  assert.deepEqual(active.assets.map(asset => asset.assetRef).sort(), selection.assetRefs);
  assert.equal(JSON.stringify(fixture.current.broker.policy), original);

  const { signed } = fixture.f;
  const read = signed({
    ...prepared,
    requestId: randomUUID(),
    operation: require('../src/meta-marketing-contract').ASSET,
    assetRef: selection.assetRefs[0],
    payload: {},
  }, 'reader');
  await assert.rejects(fixture.current.broker.execute(read.raw, read.headers), { code: 'scope_denied' });
  const afterRestart = fixture.make();
  const revoked = (await send(E.OPERATIONS.revoke, { enrollmentId: selection.enrollmentId }, afterRestart, true)).data;
  assert.equal(revoked.status, 'revoked');
  assert.equal((await send(E.OPERATIONS.status, { enrollmentId: selection.enrollmentId }, afterRestart, true)).data.status, 'revoked');
});

test('an admitted gateway can read the selected inventory only for its confirmed clinic', async t => {
  const { fixture, prepared, send, selection } = await candidate(t, { credentialEpochs: true });
  const pending = (await send(E.OPERATIONS.prepare, selection)).data;
  const active = (await send(E.OPERATIONS.activate, {
    enrollmentId: selection.enrollmentId,
    scopeDigest: selection.scopeDigest,
    selectionDigest: pending.selectionDigest,
  })).data;
  const { store, admission } = fixture.current;
  const row = store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(active.enrollmentId);
  const binding = admission.resolveBinding(prepared.connectionRef);
  const credential = fixture.current.epochs.current(row, binding);
  const payload = {
    enrollmentId: active.enrollmentId,
    scopeDigest: active.scopeDigest,
    selectionDigest: active.selectionDigest,
    clinicSetDigest: active.clinicSetDigest,
    assetSetDigest: R.assetSetDigest(active.assets),
    expectedEpoch: credential.epoch,
    expectedVersionId: credential.versionId,
    expectedCandidateDigest: credential.digest,
  };

  const ownership = () => JSON.stringify([
    store.db.prepare('SELECT * FROM meta_marketing_enrollments').all(),
    store.db.prepare('SELECT * FROM meta_marketing_enrollment_assets').all(),
    store.db.prepare('SELECT * FROM meta_marketing_enrollment_claims').all(),
    store.db.prepare('SELECT * FROM asset_revocations').all(),
  ]);
  const before = ownership();
  const response = await send(E.OPERATIONS.assets, payload);
  const inventory = response.data;
  assert.deepEqual(inventory.assets.map(E.identity), active.assets);
  assert(inventory.assets.every(asset => asset.name && asset.name !== asset.id));
  assert.deepEqual(inventory.availableKinds, ['ad_account', 'facebook_page']);
  const events = store.db.prepare('SELECT event FROM audit_outbox').all().map(row => JSON.parse(row.event))
    .filter(event => event.correlationId === response.requestId);
  assert.deepEqual(events.map(event => event.action), ['integration.requested', 'integration.completed']);
  assert(events.every(event => event.connectionRef === prepared.connectionRef && event.tenantRef === prepared.tenantRef
    && event.operation === E.OPERATIONS.assets));

  const request = { ...prepared, operation: E.OPERATIONS.assets, payload };
  const other = fixture.command('clinic:124', [124]);
  await fixture.prepare(other);
  const calls = fixture.f.state.awsCalls.length;
  for (const [changes, role] of [
    [{}, true],
    [{}, 'reader'],
    [{ tenantRef: 'clinic:124', assetRef: 'meta-enroll:clinic:124' }, false],
    [{ payload: { ...payload, assetSetDigest: 'a'.repeat(64) } }, false],
  ]) {
    await assert.rejects(fixture.execute({ ...request, ...changes, requestId: randomUUID() }, fixture.current, role), { code: 'scope_denied' });
  }
  await assert.rejects(fixture.execute({ ...other, operation: E.OPERATIONS.assets, requestId: randomUUID(), payload }), { code: 'scope_denied' });
  assert.equal(fixture.f.state.awsCalls.length, calls, 'denied inventory does not read credential versions');
  assert.equal(ownership(), before);
});

test('discovery without enrollment opt-in cannot prepare a selection', async t => {
  const { fixture, send, discover, selection } = await candidate(t, { permitEnrollment: false });
  assert((await discover()).data.assets.length > 0);
  await assert.rejects(send(E.OPERATIONS.prepare, selection), { code: 'scope_denied' });
  assert.equal(fixture.current.store.db.prepare('SELECT count(*) n FROM meta_marketing_enrollments').get().n, 0);
});

test('changes to the stored admission binding during provider I/O prevent confirmation', async t => {
  const { fixture, send, selection } = await candidate(t);
  const staged = (await send(E.OPERATIONS.prepare, selection)).data;
  let mutated = false;
  fixture.f.state.afterGraph = (kind, value) => {
    if (kind === 'adaccounts' && !mutated) {
      mutated = true;
      fixture.current.store.db.prepare('UPDATE meta_marketing_admission_slots SET expires_at=expires_at+1000 WHERE scope=?').run('clinic:123');
    }
    return value;
  };
  await assert.rejects(send(E.OPERATIONS.activate, {
    enrollmentId: selection.enrollmentId,
    scopeDigest: selection.scopeDigest,
    selectionDigest: staged.selectionDigest,
  }), { code: 'scope_denied' });
  assert.equal(mutated, true);
  assert.equal(fixture.current.store.db.prepare('SELECT state FROM meta_marketing_enrollments WHERE id=?').get(selection.enrollmentId).state, 'prepared');
});

test('runtime configuration requires enrollment to be confined to opted-in discovery scopes', t => {
  const fixture = admissionFixture(t, { enrollment: true, enrollmentScopeKeys: ['clinic:123'] });
  const { validateConfig } = require('../src/meta-marketing-oauth-main');
  const config = { ...fixture.f.config, admission: fixture.settings };
  validateConfig(config);
  for (const mutate of [
    value => { value.admission.discoveryScopeKeys = []; },
    value => { value.admission.enrollmentScopeKeys = ['clinic:124']; },
    value => { value.assetEnrollment = false; },
  ]) {
    const incorrect = structuredClone(config);
    mutate(incorrect);
    assert.throws(() => validateConfig(incorrect), { code: 'invalid_request' });
  }
  const discoveryOnly = structuredClone(config);
  delete discoveryOnly.admission.enrollmentScopeKeys;
  validateConfig(discoveryOnly);
  discoveryOnly.admission.enrollmentScopeKeys = [];
  validateConfig(discoveryOnly);
});
