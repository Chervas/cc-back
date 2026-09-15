'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture, TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs');
const C = require('../src/whatsapp-onboarding-contract');
const customer = { businessId: '501', wabaIds: ['301','302'] };
const options = { customer, scopes: ['public_profile','whatsapp_business_management','whatsapp_business_messaging'] };
const reserved = f => f.current.store.db.prepare('SELECT waba_id FROM whatsapp_onboarding_wabas ORDER BY waba_id').all().map(v => v.waba_id);
test('Group enrollment proves every granted WABA owner, reserves the complete grant and remains a candidate after restart', async t => {
  const f = fixture(t, options); const flow = await f.begin(); const result = await f.finish(flow);
  assert.equal(result.data.status, 'staged'); assert.equal(result.data.connected, false);
  assert.equal(result.data.candidate.businessId, '501'); assert.deepEqual(result.data.candidate.grantedWabaIds, ['301','302']);
  assert.deepEqual(f.state.httpCalls.map(c => [c.action,c.id]), [['inspect','101'],['waba_owner','301'],['waba_owner','302'],['phones','301'],['phone_state','401']]);
  assert.deepEqual(reserved(f), ['301','302']); assert.equal(f.state.puts, 1);
  assert(f.state.heldTokens.every(b => b.every(v => v === 0)));
  f.restart(); assert.deepEqual((await f.status(flow)).data.candidate, result.data.candidate);
  assert.equal((await f.finish(flow)).replayed, true); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
  for (const secret of [TOKEN, APP, flow.code, flow.payload.state]) assert(!f.snapshot().includes(secret));
  const versions = f.records.get(f.binding.secretArn);
  assert.deepEqual(versions.get(flow.flowId).stages, ['AWSPENDING']);
  assert.deepEqual(versions.get(f.binding.whatsappOnboarding.slotVersionId).stages, ['AWSCURRENT']);
});
test('Unapproved selection is rejected before code exchange and a foreign owner of an unselected WABA prevents persistence', async t => {
  const f = fixture(t, options); const flow = await f.begin();
  await assert.rejects(f.finish(flow, { wabaId: '999' }), { code: 'scope_denied' }); assert.equal(f.state.codes, 0);
  f.state.afterGraph = (req, v) => req.action === 'waba_owner' && req.id === '302' ? { id: '302', owner_business_info: { id: '999' } } : v;
  await assert.rejects(f.finish(flow), { code: 'scope_denied' });
  assert.equal(f.state.puts, 0); assert.deepEqual(reserved(f), []);
  assert(f.state.httpCalls.every(v => !['phones','phone_state'].includes(v.action)));
  const events = f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(v => JSON.parse(v.event));
  assert(events.some(e => e.reason === 'whatsapp_failed_customer_ownership'));
  f.restart(); await assert.rejects(f.finish(flow), { code: 'oauth_flow_interrupted' }); assert.equal(f.state.codes, 1);
});
test('Unrequested events permissions and unknown granular assets fail before ownership reads', async t => {
  for (const mutate of [v => v.data.scopes.push('whatsapp_business_manage_events'), v => v.data.granular_scopes[0].target_ids.push('999')]) {
    const f = fixture(t, options); const flow = await f.begin();
    f.state.afterGraph = (req, v) => { if (req.action === 'inspect') mutate(v); return v; };
    await assert.rejects(f.finish(flow)); assert.deepEqual(f.state.httpCalls.map(v => v.action), ['inspect']);
    assert.equal(f.state.puts, 0); assert.deepEqual(reserved(f), []);
  }
});
test('Lost candidate acknowledgement reconciles the complete business grant without repeating the exchange or write', async t => {
  const f = fixture(t, options); const flow = await f.begin(); f.state.losePut = true;
  await assert.rejects(f.finish(flow), { code: 'secret_unavailable' }); f.restart();
  const result = await f.status(flow); assert.equal(result.data.status, 'staged'); assert.deepEqual(result.data.candidate.grantedWabaIds, customer.wabaIds);
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
});
test('A concurrent reservation of an unselected WABA rolls back every reservation and prevents the candidate write', async t => {
  const f = fixture(t, options); const flow = await f.begin();
  f.state.afterGraph = (req, v) => {
    if (req.action === 'phone_state') f.current.store.db.prepare('INSERT INTO whatsapp_onboarding_wabas VALUES (?,?,?,?,?,?,?,?)')
      .run('302','connection:foreign','clinic:99','wa-enroll:clinic:99',C.hash('foreign'),C.hash('[99]'),randomUUID(),f.now());
    return v;
  };
  await assert.rejects(f.finish(flow), { code: 'scope_denied' });
  assert.deepEqual(reserved(f), ['302']); assert.equal(f.state.puts, 0);
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_assets').get().n, 0);
});
test('Removing an unselected reservation prevents confirmation after an uncertain candidate write', async t => {
  const f = fixture(t, options); const flow = await f.begin(); f.state.losePut = true;
  await assert.rejects(f.finish(flow));
  f.current.store.db.prepare('DELETE FROM whatsapp_onboarding_wabas WHERE waba_id=?').run('302');
  f.restart(); await assert.rejects(f.status(flow), { code: 'scope_denied' }); assert.equal(f.state.puts, 1);
});
test('Changed business or WABA policy invalidates an existing authorization before exchanging its code', async t => {
  const f = fixture(t, options); const flow = await f.begin();
  for (const change of [{ businessId: '999' }, { wabaIds: ['301','302','303'] }]) {
    const policy = structuredClone(f.policy); Object.assign(policy.connections[0].whatsappOnboarding.customer, change);
    const next = f.make(undefined, policy);
    await assert.rejects(f.finish(flow, {}, next), { code: 'idempotency_conflict' });
    assert.equal((await f.status(flow, next)).data.configurationChanged, true);
  }
  assert.equal(f.state.codes, 0); assert.equal(f.state.puts, 0);
});
test('A business-wide grant cannot be configured through a single-clinic authorization or malformed policy', t => {
  const f = fixture(t, options);
  for (const change of [v => { v.scopeKey = 'clinic:71'; v.clinicIds = [71]; }, v => { v.customer = null; },
    v => { v.customer.wabaIds.reverse(); }, v => { v.customer.wabaIds.push('302'); }, v => { v.customer.allowAny = true; }]) {
    const b = structuredClone(f.binding); change(b.whatsappOnboarding); assert.throws(() => C.bindingFor(b));
  }
});
test('Revocation of a business authorization blocks every original clinic even after deleting its original records', async t => {
  const f = fixture(t, options); const flow = await f.begin(); await f.finish(flow);
  await f.execute(C.REVOKE, {}, { requestId: randomUUID() }, true);
  f.current.store.db.exec('DELETE FROM whatsapp_onboarding_phone_observations; DELETE FROM whatsapp_onboarding_selections; DELETE FROM whatsapp_onboarding_flows; DELETE FROM connections; DELETE FROM asset_revocations;');
  f.restart(); await assert.rejects(f.begin(), { code: 'asset_revoked' });
  assert.deepEqual(f.current.store.db.prepare('SELECT scope_key FROM whatsapp_onboarding_scope_blocks ORDER BY scope_key').all().map(v => v.scope_key), ['clinic:71','clinic:72','group:9']);
  assert.deepEqual(reserved(f), ['301','302']); assert.equal(f.state.codes, 1);
});
