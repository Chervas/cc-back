'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { provisioningFixture } = require('./whatsapp-provisioning-fixture.cjs');
const C = require('../src/whatsapp-onboarding-contract'); const P = require('../src/whatsapp-provisioning-contract');
const { TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs');
test('Automatic preparation journals one empty encrypted slot; full OAuth works after restart without a static clinic entry', async t => {
  const p = provisioningFixture(t), cmd = p.command();
  const prepared = await p.prepare(cmd); assert.equal(prepared.replayed, false); assert.equal(prepared.data.connected, false);
  assert.equal(prepared.data.status, 'prepared'); assert.equal(p.state.creates, 1); assert.equal(p.f.state.codes, 0);
  const persisted = p.current.store.db.prepare('SELECT * FROM whatsapp_provisioned_slots').get();
  assert.equal(persisted.scope, 'clinic:123'); assert.equal(persisted.state, 'ready');
  assert.equal((await p.prepare(cmd)).replayed, true); assert.equal(p.state.creates, 1);
  assert.equal(p.current.store.db.prepare('SELECT count(*) AS n FROM audit_outbox').get().n, 2);
  p.current.close(); const restarted = p.make();
  const flow = { ...cmd, requestId: randomUUID(), operation: C.OPERATIONS.begin, payload: {
    state: randomBytes(32).toString('base64url'), expiresAt: p.f.now() + 600000,
    scopeDigest: cmd.payload.scopeDigest, clinicSetDigest: cmd.payload.clinicSetDigest } };
  assert.equal((await p.execute(flow, restarted)).data.status, 'awaiting');
  const finish = { ...cmd, requestId: randomUUID(), operation: C.OPERATIONS.finish, payload: {
    flowId: flow.requestId, state: flow.payload.state, code: 'FICTITIOUS_AUTOMATIC_CODE', wabaId: '301', phoneId: '401' } };
  const completed = await p.execute(finish, restarted); assert.equal(completed.data.status, 'staged');
  assert.equal(completed.data.connected, false); assert.equal(p.f.state.codes, 1); assert.equal(p.f.state.puts, 1);
  const events = restarted.store.db.prepare('SELECT event FROM audit_outbox').all();
  const audit = events.map(row => JSON.parse(row.event));
  assert(audit.length >= 4);
  for (const event of audit) {
    assert.equal(event.connectionRef, cmd.connectionRef);
    assert.equal(event.tenantRef, cmd.tenantRef);
    assert.equal(event.resourceRef, cmd.assetRef);
    assert([P.PREPARE, C.OPERATIONS.begin, C.OPERATIONS.finish].includes(event.operation));
  }
  for (const secret of [TOKEN, APP, finish.payload.code, flow.payload.state, persisted.arn]) {
    assert(!JSON.stringify(prepared).includes(secret)); assert(!JSON.stringify(events).includes(secret));
  }
  await assert.rejects(p.execute({ ...cmd, requestId: randomUUID(), operation: 'meta.whatsapp.text.send.v1', payload: {} }, restarted));
  await p.prepare(p.command(), restarted); assert.equal(p.state.creates, 1); // AWSPENDING must not replace the pinned empty version.
});
test('Revocation audit identifies the resolved automatic connection while untrusted denials stay unassigned', async t => {
  const p = provisioningFixture(t), cmd = p.command(); await p.prepare(cmd);
  const denied = { ...cmd, requestId: randomUUID(), tenantRef: 'clinic:999', operation: C.OPERATIONS.status,
    payload: {flowId: randomUUID(), readOnly: true} };
  await assert.rejects(p.execute(denied), {code: 'scope_denied'});
  const denial = JSON.parse(p.current.store.db.prepare("SELECT event FROM audit_outbox ORDER BY seq DESC LIMIT 1").get().event);
  assert.equal(denial.tenantRef, 'unassigned');assert.equal(denial.connectionRef, 'unassigned');
  const revoke = {...cmd,requestId:randomUUID(),operation:C.REVOKE,payload:{}};
  assert.equal((await p.execute(revoke,p.current,true)).data.revoked,true);
  const events = p.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event))
    .filter(event=>event.correlationId===revoke.requestId);
  assert.equal(events.length,2);
  for(const event of events) {assert.equal(event.connectionRef,cmd.connectionRef);assert.equal(event.operation,C.REVOKE);}
  await assert.rejects(p.prepare(p.command()),{code:'asset_revoked'});
});
test('Lost AWS create acknowledgement and two concurrent workers converge on the journaled version', async t => {
  const p = provisioningFixture(t), cmd = p.command(); p.state.loseCreate = true;
  const second = p.make(); const responses = await Promise.all([p.prepare(cmd), p.prepare(cmd, second)]);
  assert(responses.every(r => r.data.status === 'prepared')); assert.equal(p.metadata.size, 1);
  const rows = p.current.store.db.prepare('SELECT * FROM whatsapp_provisioned_slots').all(); assert.equal(rows.length, 1);
  assert.equal(p.f.records.get(rows[0].arn).size, 1);
  assert.equal(responses.filter(r => !r.replayed).length, 1);
  assert.equal(p.current.store.db.prepare('SELECT count(*) AS n FROM audit_outbox').get().n, 2);
});
test('IAM failure is sanitized and a later attempt resumes without inventing a successful connection', async t => {
  const p = provisioningFixture(t), cmd = p.command(); p.state.denied = true;
  await assert.rejects(p.prepare(cmd), { code: 'secret_unavailable', message: 'secret_unavailable' });
  assert.equal(p.current.store.db.prepare('SELECT state FROM whatsapp_provisioned_slots').get().state, 'preparing');
  assert.equal(p.current.store.db.prepare('SELECT count(*) AS n FROM connections WHERE ref=?').get(cmd.connectionRef).n, 0);
  p.current.close(); p.state.denied = false; const restarted = p.make();
  assert.equal((await p.prepare(cmd, restarted)).data.status, 'prepared'); assert.equal(p.f.state.codes, 0);
});
test('Wrong principal, scope, extra fields, expired context and static scope never create a secret', async t => {
  const p = provisioningFixture(t);
  await assert.rejects(p.prepare(p.command(), p.current, true), { code: 'scope_denied' });
  for (const mutate of [c => { c.tenantRef = 'clinic:999'; }, c => { c.connectionRef = 'wrong'; },
    c => { c.payload.secretArn = 'UNTRUSTED'; }, c => { c.payload.expiresAt = p.f.now(); },
    c => { c.payload.expiresAt = p.f.now() + 1800001; }, c => { c.payload.clinicIds = [124]; },
    c => { c.payload.clinicSetDigest = '0'.repeat(64); }]) {
    const cmd = p.command(); mutate(cmd); await assert.rejects(p.prepare(cmd));
  }
  await assert.rejects(p.prepare(p.command('group:9', [71,72])), { code: 'scope_denied' });
  const cmd = p.command('group:12', [124,123]); await assert.rejects(p.prepare(cmd), { code: 'invalid_request' });
  assert.equal(p.state.creates, 0); assert.equal(p.current.store.db.prepare('SELECT count(*) AS n FROM whatsapp_provisioned_slots').get().n, 0);
});
test('An idempotency key cannot create a different clinic or change the authorized group members', async t => {
  const p = provisioningFixture(t), cmd = p.command('group:12', [123,124]); await p.prepare(cmd);
  await assert.rejects(p.prepare(p.command('clinic:125', [125], { requestId: cmd.requestId })), { code: 'idempotency_conflict' });
  await assert.rejects(p.prepare(p.command('group:12', [123,124,125])), { code: 'idempotency_conflict' });
  assert.equal(p.state.creates, 1);
});
test('Changing the capacity preserves existing grants and still caps creation', async t => {
  const p = provisioningFixture(t), onlyOne = p.make(undefined, { ...p.settings, maxConnections: 1 });
  await p.prepare(p.command(), onlyOne);
  await assert.rejects(p.prepare(p.command('clinic:124', [124]), onlyOne), { code: 'rate_limited' });
  const increased = p.make(undefined, { ...p.settings, maxConnections: 2 });
  assert(increased.provisioner.resolveBinding(P.connectionRef('clinic:123')));
  await p.prepare(p.command('clinic:124', [124]), increased); assert.equal(p.metadata.size, 2);
});
test('Blocks before or during AWS calls and after restart cannot be undone by automatic preparation', async t => {
  const p = provisioningFixture(t), cmd = p.command('group:12', [123,124]);
  p.state.after = (command, result) => {
    if (command.constructor.name === 'CreateSecretCommand') p.current.store.db.prepare('INSERT INTO whatsapp_onboarding_scope_blocks VALUES (?,?,?,?)')
      .run('clinic:124', cmd.connectionRef, randomUUID(), p.f.now());
    return result;
  };
  await assert.rejects(p.prepare(cmd), { code: 'asset_revoked' }); assert.equal(p.metadata.size, 1);
  p.current.close(); const restarted = p.make(); await assert.rejects(p.prepare(cmd, restarted), { code: 'asset_revoked' });
  assert.equal(p.state.creates, 1);
  const other = p.command('clinic:125', [125]); p.state.after = null; await p.prepare(other, restarted);
  restarted.store.db.prepare("UPDATE connections SET state='blocked' WHERE ref=?").run(other.connectionRef);
  await assert.rejects(p.prepare(other, restarted), { code: 'connection_blocked' });
});
test('Changing placeholder ownership, KMS, contents, version or deleting a ready slot is never repaired by overwrite', async t => {
  for (const mutation of ['tags','kms','body','version','deleted','missing']) await t.test(mutation, async t => {
    const p = provisioningFixture(t), cmd = p.command(); await p.prepare(cmd);
    const row = p.current.store.db.prepare('SELECT * FROM whatsapp_provisioned_slots').get(); const metadata = p.metadata.get(row.name);
    if (mutation === 'tags') metadata.Tags = [];
    if (mutation === 'kms') metadata.KmsKeyId = 'UNTRUSTED_KMS';
    if (mutation === 'deleted') metadata.DeletedDate = new Date();
    if (mutation === 'body') p.f.records.get(row.arn).get(row.version_id).body = JSON.stringify({ provider: 'FOREIGN_VALUE' });
    if (mutation === 'version') p.f.records.get(row.arn).get(row.version_id).stages = ['AWSPREVIOUS'];
    if (mutation === 'missing') p.f.records.delete(row.arn);
    await assert.rejects(p.prepare(cmd), { code: 'secret_unavailable' }); assert.equal(p.state.creates, 1);
  });
});
test('No expired context can become ready after slow AWS; the next fresh context may resume the empty slot', async t => {
  const p = provisioningFixture(t), cmd = p.command();
  p.state.after = (command, result) => { if (command.constructor.name === 'CreateSecretCommand') p.f.state.clock += 600001; return result; };
  await assert.rejects(p.prepare(cmd), { code: 'oauth_flow_interrupted' });
  assert.equal(p.current.store.db.prepare('SELECT state FROM whatsapp_provisioned_slots').get().state, 'preparing');
  p.state.after = null; await p.prepare(p.command()); assert.equal(p.state.creates, 1);
});
