'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const C = require('../src/meta-marketing-oauth-contract');
const D = require('../src/meta-marketing-discovery-contract');
const E = require('../src/meta-marketing-enrollment-contract');
const { admissionFixture } = require('./meta-marketing-admission-fixture.cjs');

async function candidate(t, { permitEnrollment = true } = {}) {
  const fixture = admissionFixture(t, {
    discovery: true,
    discoveryScopeKeys: ['clinic:123'],
    enrollment: true,
    enrollmentScopeKeys: permitEnrollment ? ['clinic:123'] : [],
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
