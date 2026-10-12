'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { randomUUID } = require('node:crypto'); const { BrokerStore } = require('../src/store');
const { createCapacity, DEFAULTS, validate } = require('../src/whatsapp-dispatch-capacity');
const C = require('../src/whatsapp-authorized-contract'); const S = require('../src/whatsapp-authorized-status');
const R = require('../src/whatsapp-send-receipt'); const { fixture } = require('./whatsapp-authorized-fixture.cjs');
function gate(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-capacity-')); const filename = path.join(dir, 'state.sqlite');
  const store = new BrokerStore(filename); let now = 600000;
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, capacity: createCapacity({ store, now: () => now }), next: () => { now += 60000; }, tick: ms => { now += ms; },
    request: (clinic, lane = 'clinical', operation = C.SEND) => ({ request: { tenantRef: 'clinic:' + clinic, operation,
      payload: operation === C.SEND ? { dispatchLane: lane } : {} } }) };
}
test('configuration bounds preserve reserved connection slots', () => {
  validate(DEFAULTS);
  for (const change of [{ maxPerMinute: 601 }, { managementSlots: 8 }, { clinicalReserve: 500 }, { clinicSlots: 7 }])
    assert.throws(() => validate({ ...DEFAULTS, ...change }), { code: 'invalid_request' });
});
test('commercial traffic cannot monopolize a clinic or connection/permission capacity', t => {
  const f = gate(t); const release = f.capacity.acquire(f.request(1, 'commercial'));
  assert.throws(() => f.capacity.acquire(f.request(1, 'commercial')), { code: 'whatsapp_capacity_concurrency' });
  const clinical = f.capacity.acquire(f.request(1));
  const others = [2, 3, 4, 5].map(id => f.capacity.acquire(f.request(id)));
  assert.throws(() => f.capacity.acquire(f.request(6)), { code: 'whatsapp_capacity_concurrency' });
  const control = f.capacity.acquire(f.request(7, null, S.READ));
  const reconnect = f.capacity.acquire(f.request(8, null, S.READ));
  release(); release(); clinical(); others.forEach(fn => fn()); control(); reconnect();
  f.capacity.acquire(f.request(6))();
});
test('minute reserves and per-clinic limits survive gate restart without starving connection checks', t => {
  const f = gate(t);
  for (let i = 0; i < 300; i++) f.capacity.acquire(f.request(1 + i % 20, 'commercial'))();
  assert.throws(() => f.capacity.acquire(f.request(1, 'commercial')), { code: 'whatsapp_capacity_minute' });
  const restart = createCapacity({ store: f.store, now: () => 600000 });
  assert.throws(() => restart.acquire(f.request(30, 'commercial')), { code: 'whatsapp_capacity_minute' });
  for (let i = 0; i < 200; i++) restart.acquire(f.request(30 + i % 20))();
  assert.throws(() => restart.acquire(f.request(51)), { code: 'whatsapp_capacity_minute' });
  for (let i = 0; i < 100; i++) restart.acquire(f.request(52, null, S.READ))();
  assert.throws(() => restart.acquire(f.request(52, null, S.READ)), { code: 'whatsapp_capacity_minute' });
  f.next(); f.capacity.acquire(f.request(1, 'commercial'))();
});
test('round-robin turns survive restart; a busy or vanished clinic never holds its peers indefinitely', t => {
  const f = gate(t); const release = f.capacity.acquire(f.request(1, 'commercial'));
  assert.throws(() => f.capacity.acquire(f.request(1, 'commercial')), { code: 'whatsapp_capacity_concurrency' });
  // The older waiter is currently busy, so another clinic can use its own slot.
  f.capacity.acquire(f.request(2, 'commercial'))(); release();
  assert.throws(() => f.capacity.acquire(f.request(2, 'commercial')), { code: 'whatsapp_capacity_fairness' });
  f.capacity.acquire(f.request(9, null, S.READ))();
  const restart = createCapacity({ store: f.store, now: () => 600000 });
  assert.throws(() => restart.acquire(f.request(3, 'commercial')), { code: 'whatsapp_capacity_fairness' });
  f.capacity.acquire(f.request(1, 'commercial'))(); f.capacity.acquire(f.request(2, 'commercial'))();
  f.tick(5001); f.capacity.acquire(f.request(4, 'commercial'))();
});
test('5000 simulated messages across 100 clinics drain over bounded windows; no rejected message is discarded', t => {
  const f = gate(t); let pending = Array.from({ length: 5000 }, (_, id) => ({ id, clinic: id % 100 + 1, lane: id % 3 ? 'commercial' : 'clinical' }));
  const accepted = new Set(); let windows = 0;
  while (pending.length && windows < 40) {
    const retry = [];
    for (const item of pending) {
      try { f.capacity.acquire(f.request(item.clinic, item.lane))(); assert(!accepted.has(item.id)); accepted.add(item.id); }
      catch (e) { assert(['whatsapp_capacity_minute', 'whatsapp_capacity_fairness'].includes(e.code)); retry.push(item); }
    }
    // A full send budget always leaves capacity for connection checks.
    f.capacity.acquire(f.request(101, null, S.READ))();
    pending = retry; f.next(); windows++;
  }
  assert.equal(pending.length, 0); assert.equal(accepted.size, 5000); assert(windows >= 10 && windows < 40);
});
test('scoped receipt recovers lost acceptance, never performs a second provider POST, and rejects another clinic', async t => {
  const f = await fixture(t); const request = f.request();
  await f.execute(request);
  const receipt = { ...request, requestId: randomUUID(), operation: R.READ,
    payload: { authorizationId: request.payload.authorizationId, phoneId: request.payload.phoneId, intentId: request.requestId, send: request.payload } };
  for (const grant of f.current.broker.policy.grants.filter(g => g.principalId === 'staging:whatsapp')) grant.operations.push(R.READ);
  const accepted = await f.execute(receipt); assert.equal(accepted.data.state, 'accepted'); assert.equal(f.sends().length, 1);
  await assert.rejects(f.execute({ ...receipt, requestId: randomUUID(), tenantRef: 'clinic:72' }), { code: 'scope_denied' });
  const absent = await f.execute({ ...receipt, requestId: randomUUID(), payload: { ...receipt.payload, intentId: randomUUID() } });
  assert.equal(absent.data.state, 'absent'); assert.equal(f.sends().length, 1);
  f.current.store.db.prepare("UPDATE commands SET state='unknown',result=NULL WHERE id=?").run(request.requestId);
  assert.equal((await f.execute({ ...receipt, requestId: randomUUID() })).data.state, 'unknown');
  assert.equal(f.sends().length, 1);
});
test('capacity denial is authenticated/audited before reserve or Meta and does not poison idempotency', async t => {
  const f = await fixture(t); const request = f.request();
  f.current.broker.admission = { acquire() { throw Object.assign(new (require('../src/errors').BrokerError)('whatsapp_capacity_concurrency')); } };
  await assert.rejects(f.execute(request), { code: 'whatsapp_capacity_concurrency' });
  assert.equal(f.sends().length, 0);
  assert.equal(f.current.store.db.prepare('SELECT count(*) n FROM commands').get().n, 0);
  const row = f.current.store.db.prepare('SELECT event FROM audit_outbox ORDER BY seq DESC LIMIT 1').get();
  assert.equal(JSON.parse(row.event).reason, 'whatsapp_capacity_concurrency');
  delete f.current.broker.admission;
  await f.execute(request); await f.execute(request); assert.equal(f.sends().length, 1);
});
test('commercial retry saturation in one clinic cannot exhaust another clinic or its clinical nonce budget', async t => {
  const f = await fixture(t);
  f.current.broker.policy.principals[0].maxPerMinute = 600;
  f.current.broker.policy.maxBacklog = 5000;
  f.current.broker.admission = createCapacity({ store: f.current.store, now: f.f.now });
  for (let i = 0; i < 500; i++) {
    const r = f.request(); r.payload.dispatchLane = 'commercial';
    try { await f.execute(r); } catch (e) { assert.equal(e.code, 'rate_limited'); }
  }
  const other = f.request(undefined, { tenantRef: 'clinic:72' }); other.payload.dispatchLane = 'commercial';
  await f.execute(other); await f.execute(f.request());
  assert.equal(f.sends().length, 32);
});
