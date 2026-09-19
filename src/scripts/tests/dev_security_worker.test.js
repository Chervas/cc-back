'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { assertRuntime, allowedEmail, startSecurityLoops, createEmailPoller } = require('../dev-security-worker');
const { authorize } = require('../../lib/devAuditRelay');
const { pack, keyFor } = require('../../../services/platform-audit/src/event');
const { fixture } = require('../../../services/platform-audit/test/fixture.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function waits() {
  const pending = [];
  return {
    pending,
    wait: (ms, signal) => new Promise((resolve, reject) => {
      const row = { ms, release: () => { remove(); resolve(); } };
      const remove = () => { signal.removeEventListener('abort', abort); const i = pending.indexOf(row); if (i >= 0) pending.splice(i, 1); };
      const abort = () => { remove(); reject(Object.assign(Error('stopped'), { name: 'AbortError' })); };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true }); pending.push(row);
    }),
    release: ms => { const row = pending.find(v => v.ms === ms); assert(row, 'lane is waiting after completion'); row.release(); },
  };
}
test('slow writer and reader do not block email or overlap their own runs; stop drains active calls', async () => {
  const writer = deferred(), reader = deferred(), w = waits(); const calls = { email: 0, audit: 0, reconcile: 0 };
  const loops = startSecurityLoops({ wait: w.wait,
    email: async () => { calls.email++; }, audit: async () => { calls.audit++; await writer.promise; },
    reconcile: async () => { calls.reconcile++; await reader.promise; } });
  try {
    await turn();
    for (let i = 0; i < 5; i++) { w.release(1000); await turn(); }
    assert.deepEqual(calls, { email: 6, audit: 1, reconcile: 1 });
    assert.deepEqual(w.pending.map(v => v.ms), [1000]);
    loops.stop(); let drained = false; loops.done.then(() => { drained = true; }); await turn();
    assert.equal(drained, false); assert.equal(w.pending.length, 0);
    writer.resolve(); await turn(); assert.equal(drained, false);
    reader.resolve(); await loops.done; assert.equal(calls.email, 6);
  } finally { loops.stop(); writer.resolve(); reader.resolve(); await loops.done; }
});
test('failed lanes stay paced, report bounded names and recover independently without catch-up', async () => {
  const w = waits(), errors = []; let down = true; const calls = { email: 0, audit: 0, reconcile: 0 };
  const loops = startSecurityLoops({ wait: w.wait, onError: name => errors.push(name),
    email: async () => { calls.email++; }, audit: async () => { calls.audit++; if (down) throw Error('fictitious outage'); },
    reconcile: async () => { calls.reconcile++; return down ? { error: 'fictitious failure' } : {}; } });
  try {
    await turn(); assert.deepEqual(errors, ['audit', 'reconcile']);
    for (let i = 0; i < 4; i++) { w.release(1000); await turn(); }
    assert.deepEqual(calls, { email: 5, audit: 1, reconcile: 1 });
    w.release(10000); await turn(); assert.equal(calls.audit, 2); assert.equal(errors.length, 3);
    down = false; w.release(10000); w.release(30000); await turn();
    assert.deepEqual(calls, { email: 5, audit: 3, reconcile: 2 }); assert.equal(errors.length, 3);
    assert.deepEqual(w.pending.map(v => v.ms).sort((a,b) => a-b), [1000,10000,30000]);
  } finally { loops.stop(); await loops.done; }
  assert.equal(w.pending.length, 0);
});
test('slow email cannot hold audit lanes and a fatal wait drains an in-flight email before shutdown', async () => {
  const sent = deferred(), failWait = deferred(); let audits = 0, reconciliations = 0, stopped = false;
  const loops = startSecurityLoops({ email: async closing => { await sent.promise; stopped = closing(); },
    audit: async () => { audits++; }, reconcile: async () => { reconciliations++; },
    wait: async () => { await failWait.promise; throw Error('fictitious timer failure'); } });
  const result = assert.rejects(loops.done, /fictitious timer failure/);
  await turn(); assert.equal(audits, 1); assert.equal(reconciliations, 1);
  failWait.resolve(); await turn(); assert.equal(stopped, false);
  sent.resolve(); await result; assert.equal(stopped, true);
});
test('auth email claims keep scope and uncertainty guards and finish a claimed job during stop', async () => {
  const rows = [
    { template_key: 'marketing', status: 'queued' },
    { template_key: 'auth.email_verification', status: 'sending' },
    { template_key: 'auth.email_verification', status: 'queued' },
    { template_key: 'auth.password_reset', status: 'queued' },
  ].map((row, i) => ({ ...row, id:i+1, job_request_id:i+1, recipient_kind:'user', stream:'transactional' }));
  let closing = false, sent = 0, claimed = 0;
  const queue = rows.map(row => ({ id:row.id,payload:{email_message_id:row.id},attempts:1,max_attempts:5,
    update:async function(value) { Object.assign(this,value); } })); const jobs = [...queue];
  const email = createEmailPoller({ model:{findByPk:async id => rows[id-1]},
    jobs:{claimNextJob:async (_priority,types) => { assert.deepEqual(types,['email_send']);claimed++;return queue.shift(); }},
    delivery:{runEmailSendJob:async () => { sent++;closing=true;return {status:'completed'}; }} });
  await email(() => closing);
  assert.equal(claimed,3);assert.equal(sent,1);assert.equal(queue.length,1);
  assert.equal(jobs[0].error_message,'dev_security_email_scope_denied');
  assert.equal(jobs[1].error_message,'email_delivery_outcome_unknown');assert.equal(jobs[2].status,'completed');
});
test('security consumer requires DEV database, own identity and all business workers off', () => {
  const env = { DEV_SECURITY_WORKER: 'true', DB_NAME: 'clinicaclick_dev_isolated', DB_USERNAME: 'cc_dev_api', DB_HOST: '127.0.0.1',
    RUNTIME_NAMESPACE: 'dev', JOB_RUNTIME_NAMESPACE: 'dev', QUEUE_PREFIX: 'dev', JOBS_WORKER_ENABLED: 'false',
    JOBS_CRON_LEADER: 'false', JOBS_AUTO_START: 'false', SYSTEM_NOTIFICATIONS_CRON_LEADER: 'false',
    AUTH_SESSION_MODE: 'enforce', AUTH_EMAIL_MFA_MODE: 'enforce', PLATFORM_AUDIT_READER_TRANSPORT: 'https' };
  assertRuntime(env, 'clinicaclick-dev-security');
  for (const change of [{ DB_NAME: 'public' }, { JOBS_CRON_LEADER: 'true' }, { JOB_RUNTIME_NAMESPACE: 'staging' }])
    assert.throws(() => assertRuntime({ ...env, ...change }, 'clinicaclick-dev-security'));
  assert.throws(() => assertRuntime(env, 'clinicaclick-dev'));
  const row = { template_key: 'auth.email_verification', stream: 'transactional', recipient_kind: 'user' };
  assert.equal(allowedEmail(row), true);
  for (const change of [{ template_key: 'marketing' }, { stream: 'automation' }, { clinica_id: 19 }, { paciente_id: 1 }])
    assert.equal(!!allowedEmail({ ...row, ...change }), false);
});
test('DEV relay requires live DEV session and exact locally confirmed receipt', async () => {
  const row = { ...pack(fixture()), state: 'delivered' };
  row.receipt = { key: keyFor(row), digest: row.digest, versionId: 'test-version' };
  const command = { mode: 'confirmed', requestId: randomUUID(), actorId: '1', sessionRef: randomUUID(), refs: [row.receipt] };
  let sessions = 0;
  const deps = { verifySession: async () => { sessions++; }, findEvent: async () => row };
  assert.equal(await authorize(command, deps), true); assert.equal(sessions, 1);
  await assert.rejects(authorize(command, { ...deps, findEvent: async () => null }));
  await assert.rejects(authorize(command, { ...deps, verifySession: async () => { throw Error('revoked'); } }));
  await assert.rejects(authorize({ ...command, refs: [{ ...row.receipt, versionId: 'other' }] }, deps));
  await assert.rejects(authorize({ ...command, mode: 'reconcile' }, deps));
  await assert.rejects(authorize({ ...command, actorId: '2' }, deps));
  row.state = 'pending'; await assert.rejects(authorize(command, deps));
});
