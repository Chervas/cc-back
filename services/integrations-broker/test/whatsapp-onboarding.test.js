'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { fixture, TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs'); const C = require('../src/whatsapp-onboarding-contract');
const row = (f, flow) => f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId);
test('Signed WhatsApp onboarding exchanges once, verifies new Meta identity and WABA/phone, stores only a candidate and metadata', async t => {
  const f = fixture(t); const flow = await f.begin(); assert.equal(flow.result.data.status, 'awaiting');
  assert.deepEqual(flow.result.data.authorization, { appId: '101', configId: '102', redirectUri: f.binding.whatsappOnboarding.redirectUri });
  const result = await f.finish(flow); assert.equal(result.data.status, 'staged'); assert.equal(result.data.connected, false);
  assert.equal(result.data.candidate.subjectId, '201'); assert.equal(result.data.candidate.versionId, flow.flowId); assert.equal(result.data.candidate.phoneId, '401');
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1); assert.deepEqual(f.state.httpCalls.map(c => c.action), ['inspect', 'phones']);
  assert(f.state.heldTokens.every(b => b.every(v => v === 0)));
  const versions = f.records.get(f.binding.secretArn); assert.deepEqual(versions.get(f.binding.whatsappOnboarding.slotVersionId).stages, ['AWSCURRENT']);
  assert.deepEqual(versions.get(flow.flowId).stages, ['AWSPENDING']); assert.equal(JSON.parse(versions.get(flow.flowId).body).accessToken, TOKEN);
  for (const secret of [TOKEN, APP, flow.code, flow.payload.state]) assert(!f.snapshot().includes(secret));
  const audit = f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(r => JSON.parse(r.event));
  assert(audit.every(e => e.correlationId === flow.flowId)); assert(audit.some(e => e.reason === 'whatsapp_candidate_stored'));
  assert(f.state.awsCalls.every(c => ['DescribeSecretCommand','GetSecretValueCommand','PutSecretValueCommand','ListSecretVersionIdsCommand'].includes(c.constructor.name)));
});
test('Awaiting state and completed receipt survive restart; repeated finish never exchanges or writes again', async t => {
  const f = fixture(t); const flow = await f.begin(); f.restart();
  const repeat = await f.execute(C.OPERATIONS.begin, flow.payload, { requestId: flow.flowId }); assert.equal(repeat.replayed, true);
  await f.finish(flow); f.restart(); const result = await f.finish(flow); assert.equal(result.replayed, true);
  assert.equal((await f.status(flow)).data.status, 'staged'); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
});
test('Two processes competing to finish one flow exchange only once', async t => {
  const f = fixture(t); const flow = await f.begin(); const other = f.make();
  const results = await Promise.allSettled([f.finish(flow), f.finish(flow, {}, other)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
  assert.equal((await f.status(flow)).data.status, 'staged');
});
test('Lost Secrets Manager ACK reconciles exact version/hash after restart without repeating code or Put', async t => {
  const f = fixture(t); const flow = await f.begin(); f.state.losePut = true;
  await assert.rejects(f.finish(flow), { code: 'secret_unavailable' }); assert.equal(row(f, flow).state, 'staging');
  f.restart(); const result = await f.status(flow); assert.equal(result.data.status, 'staged'); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
  assert.equal((await f.finish(flow)).replayed, true);
});
test('Unconfirmed missing candidate never reuses code, and cancellation before begin is a durable tombstone', async t => {
  const f = fixture(t); const flow = await f.begin(); f.state.failPut = true; await assert.rejects(f.finish(flow));
  f.restart(); await assert.rejects(f.status(flow), { code: 'secret_unavailable' }); await assert.rejects(f.finish(flow), { code: 'secret_unavailable' });
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1); assert.equal((await f.abort(flow, f.current, true)).data.status, 'aborted');
  const id = randomUUID(); await f.execute(C.OPERATIONS.abort, { flowId: id }, {}, true);
  await assert.rejects(f.execute(C.OPERATIONS.begin, { ...flow.payload, state: 'x'.repeat(43) }, { requestId: id }), { code: 'oauth_flow_interrupted' });
  assert.equal(f.state.codes, 1);
});
test('Foreign tenant/asset/control key, changed state/code/selection and reused code cannot authorize another exchange', async t => {
  const f = fixture(t); const flow = await f.begin();
  await assert.rejects(f.execute(C.OPERATIONS.begin, flow.payload, {}, true), { code: 'scope_denied' });
  for (const override of [{ tenantRef: 'clinic:99' }, { assetRef: 'wa-enroll:clinic:71' }, { connectionRef: 'connection:foreign' }])
    await assert.rejects(f.execute(C.OPERATIONS.status, { flowId: flow.flowId }, override), { code: 'scope_denied' });
  await assert.rejects(f.finish(flow, { state: 'x'.repeat(43) }), { code: 'oauth_state_invalid' }); assert.equal(f.state.codes, 0);
  await f.finish(flow);
  for (const changes of [{ code: 'FICTITIOUS_OTHER_CODE' }, { phoneId: '999' }, { wabaId: '999' }]) await assert.rejects(f.finish(flow, changes), { code: 'idempotency_conflict' });
  await f.abort(flow); const second = await f.begin(); await assert.rejects(f.finish(second, { code: flow.code }), { code: 'idempotency_conflict' }); assert.equal(f.state.codes, 1);
});
for (const [name, mutate] of [
  ['foreign app', r => { r.data.app_id = '999'; }], ['invalid subject', r => { delete r.data.user_id; }],
  ['Ads permission', r => { r.data.scopes.push('ads_management'); }], ['leads permission', r => { r.data.scopes.push('leads_retrieval'); }],
  ['another WABA', r => { r.data.granular_scopes[0].target_ids.push('999'); }], ['missing granular scope', r => { r.data.granular_scopes.pop(); }],
  ['revoked token', r => { r.data.is_valid = false; }],
]) test('Candidate cannot be stored for ' + name, async t => {
  const f = fixture(t); const flow = await f.begin(); f.state.afterGraph = (req, response) => { if (req.action === 'inspect') mutate(response); return response; };
  await assert.rejects(f.finish(flow)); assert.equal(f.state.puts, 0); assert.equal(row(f, flow).state, 'interrupted');
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_assets').get().n, 0);
  f.restart(); await assert.rejects(f.finish(flow), { code: 'oauth_flow_interrupted' }); assert.equal(f.state.codes, 1);
});
test('Foreign phone and durable scope block during provider work prevent candidate persistence', async t => {
  const f = fixture(t); let flow = await f.begin(); f.state.afterGraph = (req, response) => req.action === 'phones' ? { data: [{ id: '999' }] } : response;
  await assert.rejects(f.finish(flow), { code: 'scope_denied' }); assert.equal(f.state.puts, 0); await f.abort(flow);
  flow = await f.begin(); f.state.afterGraph = (req, response) => {
    if (req.action === 'phones') f.current.store.db.prepare("UPDATE connections SET state='blocked' WHERE ref=?").run(f.binding.connectionRef);
    return response;
  };
  await assert.rejects(f.finish(flow), { code: 'connection_blocked' }); assert.equal(f.state.puts, 0);
  assert.equal((await f.status(flow)).data.accessBlocked, true); assert.equal((await f.abort(flow, f.current, true)).data.status, 'aborted');
  f.restart(); await assert.rejects(f.begin(), { code: 'connection_blocked' });
});
test('Cancellation racing exchange stops persistence, retains evidence and permits no late resurrection', async t => {
  const f = fixture(t); const flow = await f.begin(); let started; const entered = new Promise(resolve => { started = resolve; }); let release;
  f.state.beforeCode = async () => { started(); await new Promise(resolve => { release = resolve; }); };
  const pending = f.finish(flow); const rejected = assert.rejects(pending, { code: 'provider_timeout' }); await entered;
  assert.equal((await f.abort(flow, f.current, true)).data.status, 'aborted'); release(); await rejected;
  assert.equal(row(f, flow).state, 'aborted'); assert.equal(f.state.puts, 0); f.restart(); await assert.rejects(f.finish(flow), { code: 'oauth_flow_interrupted' });
});
test('Audit outage rolls back begin and prevents provider call; late audit failure reconciles a staged candidate', async t => {
  const f = fixture(t); const append = f.current.store.appendAudit.bind(f.current.store);
  f.current.store.appendAudit = () => { throw Error('FICTITIOUS_AUDIT_SECRET'); };
  await assert.rejects(f.begin()); assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_flows').get().n, 0);
  f.current.store.appendAudit = append; const flow = await f.begin();
  f.current.store.appendAudit = e => { if (e.reason === 'whatsapp_candidate_stored') throw Error('FICTITIOUS_AUDIT_SECRET'); return append(e); };
  await assert.rejects(f.finish(flow)); assert.equal(row(f, flow).state, 'staging'); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1);
  f.restart(); assert.equal((await f.status(flow)).data.status, 'staged'); assert.equal(f.state.codes, 1);
});
test('Changed configuration and expiration deny further exchange; control cancellation remains available', async t => {
  const f = fixture(t); const flow = await f.begin(); const policy = structuredClone(f.policy); policy.connections[0].whatsappOnboarding.configId = '999';
  const changed = f.make(undefined, policy);
  await assert.rejects(f.finish(flow, {}, changed), { code: 'idempotency_conflict' }); assert.equal((await f.status(flow, changed)).data.configurationChanged, true);
  assert.equal((await f.abort(flow, changed, true)).data.status, 'aborted');
  const expiry = await f.begin(); f.state.clock += 600000; await assert.rejects(f.finish(expiry), { code: 'oauth_flow_interrupted' });
  assert.equal((await f.status(expiry)).data.expired, true); assert.equal(f.state.codes, 0);
});
test('One authorized scope can prepare multiple numbers on its WABA while foreign clinics cannot claim that WABA', async t => {
  const f = fixture(t); const first = await f.begin(); await f.finish(first); await f.abort(first);
  f.state.afterGraph = (req, response) => req.action === 'phones' ? { data: [{ id: '402' }] } : response;
  const second = await f.begin(); assert.equal((await f.finish(second, { phoneId: '402' })).data.candidate.phoneId, '402');
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_wabas').get().n, 1);
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_onboarding_assets').get().n, 2);
  const policy = structuredClone(f.policy); const binding = structuredClone(f.binding);
  binding.connectionRef = 'connection:wa-other'; binding.secretArn = binding.secretArn.replace('qa-candidate-', 'qa-other-');
  binding.whatsappOnboarding.scopeKey = 'clinic:73'; binding.whatsappOnboarding.clinicIds = [73]; policy.connections.push(binding);
  for (const grant of [...policy.grants]) policy.grants.push({ ...grant, connectionRef: binding.connectionRef, tenantRef: 'clinic:73', assetRef: 'wa-enroll:clinic:73' });
  const other = f.make(undefined, policy); const id = randomUUID(); const payload = { ...first.payload, state: 'y'.repeat(43), scopeDigest: C.hash('other-clinic'), clinicSetDigest: C.clinicDigest(binding.whatsappOnboarding) };
  const scope = { requestId: id, connectionRef: binding.connectionRef, tenantRef: 'clinic:73', assetRef: 'wa-enroll:clinic:73' };
  await f.execute(C.OPERATIONS.begin, payload, scope, false, other);
  await assert.rejects(f.execute(C.OPERATIONS.finish, { flowId: id, state: payload.state, code: 'FICTITIOUS_OTHER_SCOPE_CODE', wabaId: '301', phoneId: '403' }, scope, false, other), { code: 'scope_denied' });
  assert.equal(f.state.codes, 2); assert.equal(f.state.puts, 2);
});
test('Scope revocation is atomic with audit and blocks original clinics after deleting old flows and connection', async t => {
  const f = fixture(t); const flow = await f.begin(); const requestId = randomUUID();
  await assert.rejects(f.execute(C.REVOKE, {}, { requestId }), { code: 'scope_denied' });
  const append = f.current.store.appendAudit.bind(f.current.store);
  f.current.store.appendAudit = e => { if (e.action === 'asset.revoked') throw Error('FICTITIOUS_AUDIT_OUTAGE'); return append(e); };
  await assert.rejects(f.execute(C.REVOKE, {}, { requestId }, true));
  for (const table of ['whatsapp_onboarding_scope_blocks', 'asset_revocations', 'commands']) assert.equal(f.current.store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n, 0);
  f.current.store.appendAudit = append;
  assert.equal((await f.execute(C.REVOKE, {}, { requestId }, true)).data.revoked, true);
  assert.equal((await f.execute(C.REVOKE, {}, { requestId }, true)).replayed, true);
  assert.deepEqual(f.current.store.db.prepare('SELECT scope_key FROM whatsapp_onboarding_scope_blocks ORDER BY scope_key').all().map(r => r.scope_key), ['clinic:71','clinic:72','group:9']);
  await assert.rejects(f.finish(flow), { code: 'asset_revoked' }); assert.equal(f.state.codes, 0);
  // Owned fixture only: simulate removal of original operational rows.
  f.current.store.db.exec('DELETE FROM whatsapp_onboarding_flows; DELETE FROM connections; DELETE FROM asset_revocations;');
  const policy = structuredClone(f.policy); const binding = policy.connections[0]; binding.connectionRef = 'connection:replacement';
  binding.whatsappOnboarding.scopeKey = 'clinic:71'; binding.whatsappOnboarding.clinicIds = [71];
  for (const grant of policy.grants) { grant.connectionRef = binding.connectionRef; grant.assetRef = 'wa-enroll:clinic:71'; }
  const replacement = f.make(undefined, policy);
  await assert.rejects(f.execute(C.OPERATIONS.begin, { ...flow.payload, clinicSetDigest: C.clinicDigest(binding.whatsappOnboarding) },
    { connectionRef: binding.connectionRef, assetRef: 'wa-enroll:clinic:71' }, false, replacement), { code: 'asset_revoked' }); assert.equal(f.state.codes, 0);
});
test('Restart after interrupted transport reports uncertainty and never resubmits its code', async t => {
  const f = fixture(t); const flow = await f.begin(); let enter; const entered = new Promise(resolve => { enter = resolve; }); let release;
  f.state.beforeCode = async () => { enter(); await new Promise(resolve => { release = resolve; }); };
  const pending = assert.rejects(f.finish(flow), { code: 'provider_timeout' }); await entered; f.current.engine.close(); release(); await pending;
  assert.equal(row(f, flow).state, 'exchanging'); f.restart(); assert.equal((await f.status(flow)).data.status, 'exchanging');
  await assert.rejects(f.finish(flow), { code: 'oauth_flow_interrupted' }); assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 0);
});
