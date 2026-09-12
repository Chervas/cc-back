'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { installRealtimeAccess } = require('../../lib/socket-realtime-guard');
const { packetFor } = require('../../lib/socket-payload');
const { createCapture } = require('../../services/platformAudit.realtime');
const { pack, keyFor, unpack } = require('../../../services/platform-audit/src/event');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class Socket {
  constructor(id) { this.userData = { userId: id }; this.connected = true; this.rooms = new Set(); this.inbound = new EventEmitter(); this.sent = []; }
  on(...a) { this.inbound.on(...a); } once(...a) { this.inbound.once(...a); }
  emit(...a) { this.sent.push(a); } receive(...a) { this.inbound.emit(...a); }
  join(v) { this.rooms.add(v); } leave(v) { this.rooms.delete(v); }
  disconnect() { if (this.connected) { this.connected = false; this.inbound.emit('disconnect'); } }
}
function fixture(options = {}) {
  const io = new EventEmitter(); io.sockets = { sockets: new Map() }; let allowed = true; let reads = 0;
  const descriptor = { scope: { type: 'clinic', id: '71' }, clinicIds: [71], features: ['quickchat.read_patients'], ownerId: null };
  const policy = { subscription: async (_id, ids) => ({ allowed: !ids.includes(999), clinicIds: ids.includes(999) ? [] : ids.length ? ids : [71] }),
    resolve: async () => { reads++; return descriptor; }, authorize: async () => allowed, ...options.policy };
  const entries = []; let enabled = 'true';
  const repository = { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async event => { entries.push(pack(event)); }, ...options.repository };
  const audit = createCapture({ repository, enabled: () => enabled });
  const guard = installRealtimeAccess(io, { policy, audit, verify: async socket => ({ userId: socket.userData.userId, sessionVersion: 1, jti: randomUUID() }), ...options.guard });
  const connect = id => { const socket = new Socket(id); io.sockets.sockets.set(id, socket); io.emit('connection', socket); return socket; };
  async function idle() { const until = Date.now() + 1500; while (guard.pending()) { if (Date.now() > until) throw Error('fixture timeout'); await pause(2); } }
  return { io, policy, entries, guard, connect, idle, deny() { allowed = false; }, reads: () => reads, flag(v) { enabled = v; } };
}
test('closed browser projection strips provider secrets and hidden messages, preserves phone-window identity', () => {
  const packet = packetFor('message:created', { id: 2, conversation_id: 9, content: 'FICTITIOUS_MESSAGE', metadata: { access_token: 'SECRET', phoneId: '123', hide_from_quickchat: false }, resume_text: 'SECRET' });
  assert.equal(packet.body.metadata.phoneId, '123'); assert(!JSON.stringify(packet).includes('SECRET'));
  assert.equal(packetFor('message:created', { id: 2, conversation_id: 9, metadata: { hide_from_quickchat: true } }), null);
  assert.equal(packetFor('unregistered:event', { id: 2 }), null);
  assert.equal(packetFor('message:created', { id: true, conversation_id: 9 }), null);
  const flow = packetFor('flow_execution:log', { execution_id: 4, log: { id: 2, audit_snapshot: { token: 'SECRET' }, error_message: 'SECRET' }, last_error: 'SECRET' });
  assert(!JSON.stringify(flow).includes('SECRET')); assert.equal(flow.body.log.audit_snapshot, null);
});
test('durable v5 binds only closed actor/scope/resource fields and rejects free text or impossible success', async () => {
  const f = fixture(); f.connect(501); await f.idle();
  const row = f.entries.at(-1); assert(keyFor(row).startsWith('app/platform/v5/')); assert.equal(unpack(row).body, row.body);
  for (const patch of [{ ip: '127.0.0.1' }, { reason: 'SENTINEL' }, { clinicIds: ['-1'] }, { clinicIds: ['71', '71'] }, { socketEvent: 'unread:updated' }, { sessionRef: 'SECRET' }]) assert.throws(() => pack({ ...row.event, ...patch }));
});
test('current permissions gate clinic, user and broadcast destinations; explicit denied selection clears access', async () => {
  const f = fixture(); const socket = f.connect(501); await f.idle();
  const payload = { id: 2, conversation_id: 9, content: 'FICTITIOUS_MESSAGE' };
  f.guard.deliver('message:created', payload, ['clinic:71', 'user:501']); await f.idle(); assert.equal(socket.sent.length, 1);
  f.deny(); for (const rooms of [['clinic:71'], ['user:501'], []]) f.guard.deliver('message:created', payload, rooms);
  await f.idle(); assert.equal(socket.sent.length, 1); assert.equal(f.entries.filter(v => v.event.reason === 'access_denied').length, 3);
  socket.receive('subscribe', [999]); await f.idle(); assert(!socket.rooms.has('clinic:71')); assert.equal(socket.connected, true);
});
test('outbox failure never releases packets; disabled capture performs no audit I/O and still checks permissions', async () => {
  let fail = false; const entries = [];
  const f = fixture({ repository: { append: async value => { if (fail && value.stage === 'completed') throw Error('SECRET_DATABASE_ERROR'); entries.push(value); } } });
  const socket = f.connect(501); await f.idle(); fail = true;
  f.guard.deliver('message:updated', { id: 2, conversation_id: 9, status: 'sent' }, ['clinic:71']); await f.idle();
  assert.equal(socket.sent.length, 0); assert.equal(socket.connected, false); assert.equal(entries.at(-1).stage, 'attempted');
  const off = fixture({ repository: { health: async () => { throw Error('unexpected audit I/O'); } } }); off.flag('false');
  const client = off.connect(502); await off.idle(); assert(client.connected); off.deny();
  off.guard.deliver('message:updated', { id: 2, conversation_id: 9 }, ['user:502']); await off.idle(); assert.equal(client.sent.length, 0);
});
test('authorization is repeated after audit commit and packets cannot survive a new subscription generation', async () => {
  let release; let stall = false;
  const f = fixture({ repository: { append: async v => { if (stall && v.action === 'realtime.read' && v.stage === 'completed') await new Promise(r => { release = r; }); } } });
  const socket = f.connect(501); await f.idle(); stall = true;
  f.guard.deliver('message:updated', { id: 2, conversation_id: 9 }, ['clinic:71']);
  while (!release) await pause(1); f.deny(); release(); await f.idle(); assert.equal(socket.sent.length, 0);
  stall = false; socket.receive('subscribe', [71]); await f.idle();
  let resume; f.policy.resolve = async () => { await new Promise(r => { resume = r; }); return { scope: { type: 'clinic', id: '71' }, clinicIds: [71] }; };
  f.guard.deliver('message:updated', { id: 2, conversation_id: 9 }, ['clinic:71']);
  while (!resume) await pause(1); socket.receive('subscribe', [72]); resume(); await f.idle(); assert.equal(socket.sent.length, 0);
});
test('per-socket FIFO, queue overflow and deadline prevent unbounded work or late delivery', async () => {
  let release; let hold = true; const entered = [];
  const f = fixture({ guard: { maxPerSocket: 3, concurrency: 2, timeoutMs: 80 }, policy: { resolve: async p => {
    entered.push(p.body.id); if (hold) await new Promise(r => { release = r; });
    return { scope: { type: 'clinic', id: '71' }, clinicIds: [71] };
  } } });
  const socket = f.connect(501); await f.idle();
  f.guard.deliver('message:updated', { id: 1, conversation_id: 9 }, ['clinic:71']);
  while (!release) await pause(1);
  f.guard.deliver('message:updated', { id: 2, conversation_id: 9 }, ['clinic:71']);
  await pause(10); assert.deepEqual(entered, [1]);
  await pause(90); assert.equal(socket.connected, false); assert.equal(f.guard.pending(), 2);
  hold = false; release(); await f.idle(); assert.equal(socket.sent.length, 0); assert.deepEqual(entered, [1]);
  const overflow = fixture({ guard: { maxPerSocket: 1 } }); const other = overflow.connect(502);
  other.receive('subscribe', [71]); await overflow.idle(); assert.equal(other.connected, false);
});
test('browser sanitization does not modify Redis producer payloads', () => {
  const original = { id: 2, conversation_id: 9, metadata: { token: 'SENTINEL' }, resume_text: 'FICTITIOUS_RESUME' };
  const before = JSON.stringify(original); packetFor('message:created', original); assert.equal(JSON.stringify(original), before);
});
test('socket bus uses the central browser guard while preserving internal Redis envelopes and listeners', async () => {
  const connections = []; class FakeRedis extends EventEmitter {
    constructor() { super(); connections.push(this); } subscribe() { return Promise.resolve(); }
    publish(channel, raw) { this.published = { channel, raw }; return Promise.resolve(1); }
  }
  const redisPath = require.resolve('ioredis'); const previous = require.cache[redisPath];
  const busPath = require.resolve('../../services/socket.service'); const previousBus = require.cache[busPath];
  require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: FakeRedis }; delete require.cache[busPath];
  const f = fixture(); const socket = f.connect(501); await f.idle(); let internal;
  try {
    const bus = require('../../services/socket.service'); bus.setIO(f.io); bus.onBusEvent(envelope => { internal = envelope; });
    const payload = { id: 2, conversation_id: 9, content: 'FICTITIOUS', resume_text: 'FICTITIOUS_RESUME', metadata: { provider_token: 'SENTINEL' } };
    bus.getIO().to('clinic:71').emit('message:created', payload); await f.idle();
    assert.equal(socket.sent.length, 1); assert(!JSON.stringify(socket.sent).includes('SENTINEL'));
    const published = connections[1].published; assert.equal(JSON.parse(published.raw).payload.metadata.provider_token, 'SENTINEL');
    const incoming = { ...JSON.parse(published.raw), source: 'fictitious-other-process' }; f.deny();
    connections[0].emit('message', published.channel, JSON.stringify(incoming)); await f.idle();
    assert.deepEqual(internal.payload, payload); assert.equal(socket.sent.length, 1);
  } finally {
    if (previous) require.cache[redisPath] = previous; else delete require.cache[redisPath];
    if (previousBus) require.cache[busPath] = previousBus; else delete require.cache[busPath];
  }
});
