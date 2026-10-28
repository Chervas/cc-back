'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const context = require('../../lib/delegationAuditContext');
const { createService } = require('../../services/platformAudit.delegation');
const { memoryRepository, fixture } = require('../../../services/platform-audit/test/fixture.cjs');
const { prepare, update, prepareBulk } = require('../../lib/delegationJobModelHooks');
process.env.JOB_RUNTIME_NAMESPACE = 'dev';
function identity() {
  const child = randomUUID();
  return { delegationId: child, adminUserId: 1, effectiveUserId: 53, parentSessionRef: randomUUID(), childSessionRef: child,
    expiresAt: '2026-10-28T10:15:00.000Z', runtimeNamespace: 'dev' };
}
function setup(options = {}) {
  const repository = memoryRepository();
  const service = createService({ repository, enabled: () => 'true', contractVersion: () => '27', now: () => new Date('2026-10-28T10:00:00.000Z'), ...options });
  return { repository, service, events: () => [...repository.rows.values()].map(row => row.event) };
}
function model(payload, type = 'email_send', previous = null) {
  return { payload, type, getDataValue(key) { return this[key]; }, setDataValue(key, value) { this[key] = value; },
    changed: key => key === 'payload', previous: key => key === 'payload' ? previous : type };
}
test('verified ALS is isolated across concurrent users and async boundaries; spoofed extra identities are rejected', async () => {
  const first = identity(), second = { ...identity(), effectiveUserId: 221 };
  const seen = await Promise.all([first, second].map(value => context.run(value, async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    assert(Object.isFrozen(context.current().delegation));
    return context.current().delegation.effectiveUserId;
  })));
  assert.deepEqual(seen, ['53', '221']); assert.equal(context.current(), null);
  assert.throws(() => context.run({ ...first, actor: 'untrusted' }, () => {}));
  assert.throws(() => context.run({ ...first, effectiveUserId: first.adminUserId }, () => {}));
});
test('lifecycle append shares caller transaction, carries both IDs and excludes all credentials', async () => {
  const d = identity(), transaction = { id: 'fictitious-sql-transaction' }, calls = [];
  const { service, events } = setup({ repository: { health: async (...args) => { calls.push(args[1].transaction); return { pending: 0, oldestAgeSeconds: 0 }; },
    append: async (event, options) => { calls.push(options.transaction); return memory.append(event); } } });
  const memory = memoryRepository();
  await service.lifecycle({ ...d, action: 'delegation.started', reason: 'handoff_exchanged', correlationId: randomUUID() }, { transaction });
  assert.deepEqual(calls, [transaction, transaction]);
  const event = [...memory.rows.values()][0].event;
  assert.equal(event.actor.id, '1'); assert.equal(event.effectiveActor.id, '53'); assert.equal(event.sessionRef, d.childSessionRef);
  for (const key of ['token', 'password', 'email', 'handoff', 'pkce', 'amr']) assert(!Object.hasOwn(event, key));
});
test('disabled, wrong consumer generation, unhealthy queue and SQL failure deny admission before business work', async () => {
  for (const options of [{ enabled: () => 'false' }, { contractVersion: () => '26' },
    { repository: { health: async () => ({ pending: 10000, oldestAgeSeconds: 0 }) } },
    { repository: { health: async () => ({ pending: undefined, oldestAgeSeconds: 0 }) } },
    { repository: { health: async () => ({ pending: 0, oldestAgeSeconds: NaN }) } },
    { repository: { health: async () => { throw Error('SENTINEL_SQL_SECRET'); } } }]) {
    const { service } = setup(options); let next = 0;
    await assert.rejects(service.admitHttp({ authDelegation: identity(), method: 'PATCH' }, {}, () => next++), /delegation_audit_unavailable/);
    assert.equal(next, 0);
  }
});
function response() {
  const res = new EventEmitter(); res.statusCode = 200; res.headersSent = false;
  res.setHeader = () => {}; res.removeHeader = () => {};
  res.finished = new Promise(resolve => { res.end = body => { res.headersSent = true; res.body = body; resolve(); return res; }; });
  return res;
}
test('HTTP logs trusted pattern/method and observed status, with ALS; no body/query/headers or false business success', async () => {
  const { service, events } = setup(), req = { authDelegation: identity(), method: 'PATCH',
    originalUrl: '/secret/SENTINEL_URL', query: { code: 'SENTINEL_CODE' }, headers: { authorization: 'SENTINEL_JWT' }, body: { note: 'SENTINEL_PII' } };
  const res = response(); let target;
  await service.admitHttp(req, res, () => {
    target = context.current().delegation.effectiveUserId;
    req.route = { path: '/:appointmentId' }; res.statusCode = 409; res.end('conflict');
  });
  await res.finished;
  assert.equal(target, '53'); assert.equal(events().length, 2);
  assert.equal(events()[0].stage, 'attempted'); assert.equal(events()[1].http.route, '/:appointmentId');
  assert.equal(events()[1].http.status, 409); assert.equal(events()[1].outcome, 'observed');
  assert.equal(events()[0].correlationId, events()[1].correlationId); assert(!JSON.stringify(events()).includes('SENTINEL'));
});
test('nested route authentication captures one HTTP attempt and response, preserving the same request correlation', async () => {
  const { service, events } = setup(), req = { authDelegation: identity(), method: 'PATCH' }, res = response();
  const seen = [];
  await service.admitHttp(req, res, () => {
    seen.push(context.current().requestCorrelationId);
    return service.admitHttp(req, res, () => { seen.push(context.current().requestCorrelationId); res.end('ok'); });
  });
  await res.finished; assert.equal(events().length, 2); assert.equal(seen[0], seen[1]);
});
test('lost HTTP result remains a durable attempt; a failed outcome write cannot return the business response', async () => {
  const memory = memoryRepository(); let writes = 0;
  const { service } = setup({ repository: { health: memory.health, append: async event => {
    if (++writes === 2) throw Error('SENTINEL_SQL_SECRET'); return memory.append(event);
  } } });
  const res = response();
  await service.admitHttp({ authDelegation: identity(), method: 'POST', route: { path: '/:id' } }, res, () => res.end('SENTINEL_BUSINESS_RESPONSE'));
  await res.finished;
  assert.equal(res.statusCode, 503); assert(!res.body.includes('SENTINEL')); assert.equal(memory.rows.size, 1);
  assert.equal(JSON.parse(res.body).error, 'delegated_response_unconfirmed');
  assert.equal(JSON.parse(res.body).operationMayHaveCompleted, true);
});
test('socket admission records event name but no packet payload and enters target ALS only after durable capture', async () => {
  const { service, events } = setup(); let target;
  await service.admitSocket({ authDelegation: identity() }, ['subscribe', { note: 'SENTINEL_PII' }], () => { target = context.current().delegation.effectiveUserId; });
  assert.equal(target, '53'); assert.equal(events()[0].reason, 'packet_admitted');
  assert.deepEqual(events()[0].socket, { event: 'subscribe' }); assert(!JSON.stringify(events()).includes('SENTINEL'));
});
test('native model creation replaces client attribution and preserves only server context; bulk direct creates covered', () => {
  const injected = { [context.PAYLOAD_KEY]: { adminUserId: '1', signature: 'SENTINEL' }, messageId: 10 };
  const ordinary = model(injected); prepare(ordinary); assert(!Object.hasOwn(ordinary.payload, context.PAYLOAD_KEY));
  context.run(identity(), () => {
    const rows = [model(injected), model({ messageId: 11 })]; prepareBulk(rows);
    for (const row of rows) {
      const restored = context.restoreJob(row.payload, { kind: 'native', type: 'email_send' });
      assert.equal(restored.delegation.effectiveUserId, '53'); assert.equal(restored.delegation.adminUserId, '1');
      assert(!JSON.stringify(row.payload).includes('SENTINEL'));
    }
    assert.notEqual(rows[0].payload[context.PAYLOAD_KEY].data.enqueueRef, rows[1].payload[context.PAYLOAD_KEY].data.enqueueRef);
  });
});
const reorder = value => value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reorder(value[k])])) : value;
test('persisted HMAC survives MySQL JSON key ordering and rejects actor, purpose, signature and namespace tampering', () => {
  let payload; context.run(identity(), () => { payload = context.attachJob({ messageId: 10 }, { kind: 'native', type: 'email_send' }); });
  assert.equal(context.restoreJob(reorder(payload), { kind: 'native', type: 'email_send' }).delegation.effectiveUserId, '53');
  assert.throws(() => context.restoreJob(payload, { kind: 'bull', type: 'email_send' }));
  assert.throws(() => context.restoreJob(payload, { kind: 'native', type: 'provider_disconnect' }));
  const altered = JSON.parse(JSON.stringify(payload)); altered[context.PAYLOAD_KEY].data.delegation.adminUserId = 44;
  assert.throws(() => context.restoreJob(altered, { kind: 'native', type: 'email_send' }));
  const other = context.createAttribution({ secret: () => process.env.JWT_SECRET, namespace: () => 'staging' });
  assert.throws(() => other.restore(payload, { kind: 'native', type: 'email_send' }));
});
test('scheduler checkpoint updates retain verified attribution and reject arbitrary replacement JSON', () => {
  let payload; context.run(identity(), () => { const row = model({ messageId: 10 }); prepare(row); payload = row.payload; });
  const row = model({ messageId: 10, checkpoint: 2, [context.PAYLOAD_KEY]: { signature: 'SENTINEL' } }, 'email_send', payload);
  update(row); assert.equal(row.payload.checkpoint, 2);
  assert.deepEqual(row.payload[context.PAYLOAD_KEY], payload[context.PAYLOAD_KEY]);
});
test('real job runner reaches a fictitious provider as target with original admin attributed; no JWT or envelope reaches handler', async () => {
  const { service, events } = setup(); let payload;
  context.run(identity(), () => { payload = context.attachJob({ messageId: 10 }, { kind: 'native', type: 'email_send' }); });
  let sends = 0;
  const provider = { send: async () => { sends++; return { accepted: true }; } };
  const result = await service.runJob(reorder(payload), { kind: 'native', type: 'email_send', jobRef: '10', attempt: 1 }, async clean => {
    assert.deepEqual(clean, { messageId: 10 }); assert.equal(context.current().delegation.effectiveUserId, '53');
    await provider.send(); return { status: 'completed' };
  });
  assert.equal(sends, 1); assert.equal(result.status, 'completed');
  assert.deepEqual(events().map(v => v.reason), ['job_admitted', 'job_handler_returned']);
  assert(events().every(v => v.adminUserId === '1' && v.effectiveActor.id === '53' && v.actor.id === 'native:10'));
  assert.equal(events()[1].outcome, 'observed'); assert(!JSON.stringify(events()).includes('accepted'));
});
test('invalid attribution and unavailable audit prevent queued side effects; normal jobs keep existing no-audit path', async () => {
  const { service } = setup({ enabled: () => 'false' }); let calls = 0, payload;
  context.run(identity(), () => { payload = context.attachJob({}, { kind: 'native', type: 'email_send' }); });
  await assert.rejects(service.runJob(payload, { kind: 'native', type: 'email_send', jobRef: '10', attempt: 1 }, () => calls++));
  assert.equal(calls, 0);
  assert.equal(await service.runJob({ messageId: 10 }, { kind: 'native', type: 'email_send' }, () => ++calls), 1);
});
test('canonical audit linkage uses caller SQL transaction and keeps the original strict event unmodified', async () => {
  const { service, events } = setup(), source = fixture({ actor: { type: 'user', id: '53' } }), snapshot = JSON.stringify(source), transaction = { id: 'fictitious' };
  await context.run(identity(), () => service.canonicalEvent(source, { transaction }));
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(events()[0].sourceEvent.eventId, source.eventId); assert.equal(events()[0].sourceEvent.version, 1);
  assert.equal(events()[0].effectiveActor.id, '53'); assert.equal(events()[0].actor.id, '1');
  await assert.rejects(context.run(identity(), () => service.canonicalEvent(fixture({ actor: { type: 'user', id: '1' } }), { transaction })),
    /delegation_audit_unavailable/, 'a domain event cannot silently use the original administrator as its effective user');
});
test('actual repository pairs canonical event and delegated attribution in one SQL transaction; a failed attribution rolls back both', async () => {
  const { createRepository } = require('../../services/platformAudit.repository');
  for (const failLink of [false, true]) {
    const committed = [], writes = [];
    const sql = { transaction: async work => { const transaction = { rows: [] }; const value = await work(transaction);
      committed.push(...transaction.rows); return value; } };
    const model = { sequelize: sql, count: async () => 0, min: async () => null,
      create: async (row, options) => { assert(options.transaction, 'both writes require the same transaction'); writes.push(options.transaction);
        if (failLink && JSON.parse(row.body).version === 27) throw Error('SENTINEL_LINK_FAILURE');
        options.transaction.rows.push(row); } };
    let service;
    const repository = createRepository(model, { delegationAudit: { canonicalEvent: (...args) => service.canonicalEvent(...args) } });
    service = createService({ repository, enabled: () => 'true', contractVersion: () => '27', now: () => new Date('2026-10-28T10:00:00.000Z') });
    const work = () => context.run(identity(), () => repository.append(fixture({ actor: { type: 'user', id: '53' } })));
    if (failLink) { await assert.rejects(work(), /delegation_audit_unavailable/); assert.equal(committed.length, 0); }
    else { await work(); assert.deepEqual(committed.map(row => JSON.parse(row.body).version), [1, 27]); }
    assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]);
  }
});
test('actual Bull queue producer/worker wrappers retain verified attribution while the provider sees only business payload', async () => {
  const vm = require('node:vm'), fs = require('node:fs'); const { service, events } = setup();
  class Queue {
    constructor(name) { this.name = name; this.jobs = []; }
    add(name, data) { const job = { id: '501', name, data: JSON.parse(JSON.stringify(data)), attemptsMade: 0,
      updateData: async next => { job.data = next; } }; this.jobs.push(job); return Promise.resolve(job); }
    addBulk(jobs) { return Promise.all(jobs.map(job => this.add(job.name, job.data))); }
  }
  class Worker { constructor(name, processor) { this.name = name; this.processor = processor; } }
  class Events { on() {} }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/queue.service'), 'utf8'), {
    process, console, module, exports: module.exports, require: name => {
      if (name === 'bullmq') return { Queue, Worker, QueueEvents: Events };
      if (name === 'ioredis') return class Redis {};
      if (name === '../lib/delegationAuditContext') return context;
      if (name === './platformAudit.delegation') return service;
      throw Error('unexpected dependency: ' + name);
    },
  });
  const { queues, createWorker } = module.exports; let job;
  await context.run(identity(), async () => { job = await queues.outboundWhatsApp.add('send', { messageId: 50, [context.PAYLOAD_KEY]: { signature: 'SENTINEL' } }); });
  let sends = 0;
  const worker = createWorker('outbound_whatsapp', async received => {
    assert.equal(context.current().delegation.effectiveUserId, '53'); assert.deepEqual(received.data, { messageId: 50 });
    await received.updateData({ messageId: 50, checkpoint: 1 }); sends++; return { status: 'completed' };
  });
  await worker.worker.processor(job); assert.equal(sends, 1); assert.equal(events().length, 2);
  assert.equal(events()[0].job.type, 'outbound_whatsapp:send');
  assert.equal(context.restoreJob(job.data, { kind: 'bull', type: 'outbound_whatsapp:send' }).delegation.adminUserId, '1');
});
test('deferred realtime delivery selects its verified recipient, not another producer async identity; delegated capture cannot be disabled', async () => {
  const { createCapture } = require('../../services/platformAudit.realtime');
  const { service, repository, events } = setup();
  const capture = createCapture({ repository, enabled: () => 'false', delegationAudit: () => service });
  const producer = identity(), recipient = { ...identity(), effectiveUserId: 221 };
  let seen;
  await context.run(producer, () => capture.run({ userId: 221, authDelegation: recipient }, {
    action: 'realtime.subscribe', scope: { type: 'platform', id: null }, resource: { type: 'subscription', id: null }, socketEvent: null,
  }, async () => { seen = context.current().delegation.effectiveUserId; return { allowed: true, clinicIds: [] }; }));
  assert.equal(seen, '221'); assert.equal(events().length, 2); assert(events().every(v => v.actor.id === '221'));
  await context.run(producer, () => capture.run({ userId: 1 }, {}, async () => { assert.equal(context.current(), null); }));
});
test('audit route labels cover server mounts and distinguish modules without reflecting dynamic base values or queries', () => {
  const fs = require('node:fs'), routes = require('../../lib/delegationHttpRoute');
  const app = fs.readFileSync(require.resolve('../../app'), 'utf8');
  const roots = [...app.matchAll(/app\.use\(\s*(['"])(\/[^'"]*)\1/g)].map(match => match[2]).filter(value => value !== '/');
  for (const root of roots) assert(routes.PREFIXES.includes(root), 'new mounted module needs an explicit safe label: ' + root);
  assert.equal(routes.routeFor({ baseUrl: '/api/citas', route: { path: '/' } }), '/api/citas/');
  assert.equal(routes.routeFor({ baseUrl: '/api/users', route: { path: '/' } }), '/api/users/');
  assert.equal(routes.routeFor({ baseUrl: '/API/CITAS', route: { path: '/:id' } }), '/api/citas/:id');
  assert.equal(routes.routeFor({ baseUrl: '/api/auth/delegations', route: { path: '/:id/revoke' } }), '/api/auth/delegations/:id/revoke');
  const route = routes.routeFor({ baseUrl: '/api/pacientes/SENTINEL_PATIENT_PRIVATE', route: { path: '/:id' }, originalUrl: '/SENTINEL_SECRET?token=SENTINEL' });
  assert.equal(route, '/api/pacientes/:id'); assert(!route.includes('SENTINEL'));
  assert.equal(routes.routeFor({ baseUrl: '', route: { path: '/:id' } }, '/api/personal'), '/api/personal/:id');
});
test('actual Express JSON, gzip and streaming responses preserve chaining/end arguments while safe module patterns are captured', async t => {
  const http = require('node:http'), express = require('express'), zlib = require('node:zlib');
  const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
  const { service, events } = setup(); const app = express(); app.use(express.json()); let gzipCallbacks = 0;
  const router = express.Router();
  router.use((req, res, next) => { req.authDelegation = identity(); service.admitHttp(req, res, next).catch(next); });
  router.post('/:id', (req, res) => { assert.equal(res.status(201).json({ ok: true }), res); });
  router.get('/gzip/:id', (_req, res) => {
    const bytes = zlib.gzipSync(Buffer.from('{"gzip":true}'));
    res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Content-Length', bytes.length);
    assert.equal(res.end(bytes, () => gzipCallbacks++), res);
  });
  router.get('/stream/:id', (_req, res) => { res.write('{"stream":'); assert.equal(res.end('true}'), res); });
  app.use('/api/citas', router);
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      createConnection: connectionForTestServer(server), headers: { 'Content-Type': 'application/json', Authorization: 'SENTINEL_JWT' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end(method === 'POST' ? '{"note":"SENTINEL_PII"}' : undefined);
  });
  const json = await request('/api/citas/SENTINEL_PATIENT?code=SENTINEL_QUERY', 'POST');
  assert.equal(json.status, 201); assert.deepEqual(JSON.parse(json.bytes.toString()), { ok: true });
  const gzip = await request('/api/citas/gzip/SENTINEL_PATIENT');
  assert.equal(gzip.headers['content-encoding'], 'gzip'); assert.equal(zlib.gunzipSync(gzip.bytes).toString(), '{"gzip":true}');
  const stream = await request('/api/citas/stream/SENTINEL_PATIENT'); assert.equal(stream.bytes.toString(), '{"stream":true}');
  assert.equal(gzipCallbacks, 1);
  assert.deepEqual(events().filter(v => v.stage === 'completed').map(v => v.http.route), ['/api/citas/:id', '/api/citas/gzip/:id', '/api/citas/stream/:id']);
  assert(!JSON.stringify(events()).includes('SENTINEL'));
});
test('aborted responses retain unknown result; an outcome capture failure after headers destroys the stream without a second JSON response', async () => {
  const { service, events } = setup(), req = { authDelegation: identity(), method: 'GET', baseUrl: '/api/citas' }, res = response();
  await service.admitHttp(req, res, () => {}); res.emit('close'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(events()[1].outcome, 'unknown'); assert.equal(events()[1].reason, 'connection_closed'); assert.equal(events()[1].http.status, null);
  const memory = memoryRepository(); let writes = 0, destroyed = 0, ended = 0;
  const failure = setup({ repository: { health: memory.health, append: async event => { if (++writes === 2) throw Error('SENTINEL'); return memory.append(event); } } }).service;
  const stream = new EventEmitter(); stream.headersSent = true; stream.statusCode = 200;
  stream.end = () => { ended++; }; stream.destroy = () => { destroyed++; };
  await failure.admitHttp({ authDelegation: identity(), method: 'GET' }, stream, () => stream.end('tail'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(destroyed, 1); assert.equal(ended, 0); assert.equal(memory.rows.size, 1);
});
