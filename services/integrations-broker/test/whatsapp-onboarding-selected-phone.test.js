'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./whatsapp-onboarding-fixture.cjs'); const C = require('../src/whatsapp-onboarding-contract');
const scopes = ['public_profile','whatsapp_business_manage_events','whatsapp_business_management','whatsapp_business_messaging'];
function selected(t) {
  const f = fixture(t, { customer: { selectionOnly: true }, scopes });
  f.state.afterGraph = (req, response) => {
    if (req.action === 'inspect') for (const grant of response.data.granular_scopes) grant.target_ids = ['301','302'];
    return response;
  }; return f;
}
test('Existing Meta config can stage the chosen phone with events and sibling WABAs, without claiming or activating those siblings', async t => {
  const f = selected(t); const flow = await f.begin(); const result = await f.finish(flow);
  assert.equal(result.data.connected, false); assert.equal(result.data.candidate.businessId, '501');
  assert.deepEqual(result.data.candidate.grantedWabaIds, ['301','302']); assert.deepEqual(result.data.candidate.scopes, [...scopes].sort());
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_wabas').get().n, 0);
  assert.deepEqual(f.current.store.db.prepare('SELECT phone_id FROM whatsapp_onboarding_assets').all().map(v => v.phone_id), ['401']);
  assert(f.state.httpCalls.every(v => ['inspect','waba_owner','phones','phone_state'].includes(v.action)));
  f.restart(); assert.equal((await f.status(flow)).data.status, 'staged'); assert.equal((await f.finish(flow)).replayed, true);
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
});
test('Selection scope is valid for one clinic even if the business credential includes more WABAs', t => {
  const f = selected(t); const b = structuredClone(f.binding);
  Object.assign(b.whatsappOnboarding, { scopeKey: 'clinic:71', clinicIds: [71] });
  assert.equal(C.bindingFor(b).customer.selectionOnly, true);
  delete b.whatsappOnboarding.customer.selectionOnly; assert.throws(() => C.bindingFor(b));
});
test('Optional events permission without targets does not block a proven WhatsApp phone or grant other assets', async t => {
  for (const shape of ['missing', 'untargeted', 'null', 'empty']) {
    const f = selected(t); const original = f.state.afterGraph;
    f.state.afterGraph = (req, response) => {
      const r = original(req, response);
      if (req.action === 'inspect') {
        const event = r.data.granular_scopes.find(g => g.scope === 'whatsapp_business_manage_events');
        if (shape === 'missing') r.data.granular_scopes = r.data.granular_scopes.filter(g => g !== event);
        else if (shape === 'untargeted') delete event.target_ids;
        else event.target_ids = shape === 'null' ? null : [];
      }
      return r;
    };
    const result = await f.finish(await f.begin());
    assert.equal(result.data.status, 'staged'); assert.equal(result.data.connected, false);
    assert.deepEqual(result.data.candidate.grantedWabaIds, ['301', '302']);
    assert.equal(result.data.candidate.phoneId, '401'); assert.equal(f.state.puts, 1);
    assert.deepEqual(f.state.httpCalls.filter(c => c.action === 'waba_owner').map(c => c.id), ['301','302']);
    assert.deepEqual(f.current.store.db.prepare('SELECT phone_id FROM whatsapp_onboarding_assets').all().map(r => r.phone_id), ['401']);
  }
});
test('Untargeted events never replace mandatory messaging or management proof, and malformed targets still reject', async t => {
  const mutations = [
    r => { delete r.data.granular_scopes.find(g => g.scope === 'whatsapp_business_management').target_ids; },
    r => { r.data.granular_scopes.find(g => g.scope === 'whatsapp_business_messaging').target_ids = []; },
    r => { r.data.granular_scopes.find(g => g.scope === 'whatsapp_business_messaging').target_ids = ['302']; },
    r => { r.data.granular_scopes = r.data.granular_scopes.filter(g => g.scope !== 'whatsapp_business_messaging'); },
    r => { r.data.granular_scopes.find(g => g.scope === 'whatsapp_business_manage_events').target_ids = [301]; },
    r => { r.data.granular_scopes.find(g => g.scope === 'whatsapp_business_manage_events').target_ids = '301'; },
  ];
  for (const mutate of mutations) {
    const f = selected(t); const original = f.state.afterGraph;
    f.state.afterGraph = (req, response) => {
      const r = original(req,response);
      if (req.action === 'inspect') { delete r.data.granular_scopes.find(g => g.scope === 'whatsapp_business_manage_events').target_ids; mutate(r); }
      return r;
    };
    await assert.rejects(f.finish(await f.begin()), {code:'scope_denied'});
    assert.equal(f.state.puts,0); assert.deepEqual(f.state.httpCalls.map(c => c.action),['inspect']);
  }
});
test('A sibling WABA owned by another business is rejected and neither phone nor candidate is stored', async t => {
  const f = selected(t); const original = f.state.afterGraph;
  f.state.afterGraph = (req, r) => req.action === 'waba_owner' && req.id === '302' ? { id: '302', owner_business_info: { id: '999' } } : original(req,r);
  await assert.rejects(f.finish(await f.begin()), { code: 'scope_denied' }); assert.equal(f.state.puts, 0);
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_assets').get().n, 0);
});
test('Selection mode still refuses Ads, pages, leads, business_management and unknown granular grants before owner reads', async t => {
  for (const scope of ['ads_management','pages_manage_posts','leads_retrieval','business_management','unknown_scope']) {
    const f = selected(t); const original = f.state.afterGraph;
    f.state.afterGraph = (req,r) => { r = original(req,r); if (req.action === 'inspect') r.data.scopes.push(scope); return r; };
    await assert.rejects(f.finish(await f.begin())); assert.equal(f.state.puts, 0);
    assert.deepEqual(f.state.httpCalls.map(v => v.action), ['inspect']);
  }
});
test('Selection cannot claim a phone already assigned to another clinic', async t => {
  const f = selected(t);
  f.current.store.db.prepare('INSERT INTO whatsapp_onboarding_assets VALUES (?,?,?,?,?,?,?,?,?)')
    .run('301','401','other','clinic:99','wa-enroll:clinic:99',C.hash('other'),C.hash('[99]'),'old',f.now());
  await assert.rejects(f.finish(await f.begin()), { code: 'scope_denied' }); assert.equal(f.state.codes, 0); assert.equal(f.state.puts, 0);
});
test('Lost write acknowledgement recovers the same selected number and full verified grant, without another exchange', async t => {
  const f = selected(t); const flow = await f.begin(); f.state.losePut = true;
  await assert.rejects(f.finish(flow), { code: 'secret_unavailable' }); f.restart();
  const result = await f.status(flow); assert.equal(result.data.status, 'staged'); assert.equal(result.data.candidate.phoneId, '401');
  assert.equal(f.state.puts, 1); assert.equal(f.state.codes, 1);
});
test('Explicit business and WABA pins remain enforceable in selection mode', async t => {
  const f = fixture(t, { customer: { selectionOnly: true, businessId: '501', wabaIds: ['301'] }, scopes });
  f.state.afterGraph = (req,r) => { if (req.action === 'inspect') r.data.granular_scopes[0].target_ids.push('302'); return r; };
  await assert.rejects(f.finish(await f.begin()), { code: 'scope_denied' }); assert.equal(f.state.puts, 0);
});
test('Two clinics may connect different phones on the same verified WABA without acquiring each other\'s selected phone', async t => {
  const f = selected(t); const first = await f.begin(); await f.finish(first); await f.abort(first);
  const policy = structuredClone(f.policy); const second = structuredClone(f.binding);
  second.connectionRef = 'connection:second'; second.secretArn = second.secretArn.replace('qa-candidate-', 'qa-second-');
  Object.assign(second.whatsappOnboarding, { scopeKey: 'clinic:73', clinicIds: [73] }); policy.connections.push(second);
  f.records.set(second.secretArn, new Map([[second.whatsappOnboarding.slotVersionId, { stages: ['AWSCURRENT'], body: JSON.stringify({
    version: 1, provider: 'meta-whatsapp-onboarding-slot', connectionRef: second.connectionRef, scopeKey: 'clinic:73', appId: '101',
  }) }]]));
  for (const grant of [...policy.grants]) policy.grants.push({ ...grant, connectionRef: second.connectionRef, tenantRef: 'clinic:73', assetRef: 'wa-enroll:clinic:73' });
  const other = f.make(undefined, policy); const id = randomUUID(); const scope = { connectionRef: second.connectionRef, tenantRef: 'clinic:73', assetRef: 'wa-enroll:clinic:73' };
  const payload = { ...first.payload, state: 'x'.repeat(43), scopeDigest: C.hash('second clinic'), clinicSetDigest: C.clinicDigest(second.whatsappOnboarding) };
  const original = f.state.afterGraph;
  f.state.afterGraph = (req,r) => req.action === 'phones' ? { data: [{ id: '401' },{ id: '402' }] } : original(req,r);
  await f.execute(C.OPERATIONS.begin, payload, { ...scope, requestId: id }, false, other);
  const finish = { flowId: id, state: payload.state, code: 'FICTITIOUS_SECOND_CODE', wabaId: '301', phoneId: '401' };
  await assert.rejects(f.execute(C.OPERATIONS.finish, finish, scope, false, other), { code: 'scope_denied' }); assert.equal(f.state.codes, 1);
  const result = await f.execute(C.OPERATIONS.finish, { ...finish, phoneId: '402' }, scope, false, other);
  assert.equal(result.data.status, 'staged'); assert.equal(result.data.candidate.phoneId, '402'); assert.equal(f.state.puts, 2);
  assert.deepEqual(f.current.store.db.prepare('SELECT phone_id,tenant FROM whatsapp_onboarding_assets ORDER BY phone_id').all().map(v => [v.phone_id,v.tenant]), [['401','clinic:71'],['402','clinic:73']]);
});
