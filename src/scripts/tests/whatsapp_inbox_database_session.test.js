'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInboxDatabaseSession } = require('../../lib/whatsappInboxDatabaseSession');
const { pollOnce } = require('../whatsapp-inbox-consumer');

function fixture(options = {}) {
  const calls = [], driver = new EventEmitter();
  const f = { owner: null, id: 51, readOnly: 0, superReadOnly: 0, closed: 0, destroyed: 0, connects: 0, calls };
  f.connection = { connection: driver, execute: async sql => {
    calls.push(sql);
    if (sql.includes('GET_LOCK')) { if (!f.owner) f.owner = f.id; return [[{ acquired: f.owner === f.id ? 1 : 0 }]]; }
    if (f.readError) throw Error('PRIVATE SQL DETAIL');
    return [[{ connection_id: f.id, owner_id: f.owner, read_only: f.readOnly, super_read_only: f.superReadOnly }]];
  }, query: async sql => { calls.push(sql); }, end: async () => { f.closed++; }, destroy: () => { f.destroyed++; } };
  f.session = createInboxDatabaseSession({ connect: async () => { f.connects++; return f.connection; },
    tables: ['WhatsappInboxImports'], ...options });
  return f;
}

test('one physical connection owns the lock before schema validation, with no implicit SQL or connection retry', async () => {
  const f = fixture();
  assert.equal(await f.session.open(), f.connection); await f.session.open();
  assert.equal(f.connects, 1); assert(f.calls.findIndex(sql => sql.includes('GET_LOCK')) < f.calls.findIndex(sql => sql.includes('FROM WhatsappInboxImports')));
  await f.session.assertOwnership(); f.owner = 99;
  await assert.rejects(f.session.assertOwnership(), { code: 'inbox_database_owner_lost' });
  assert.equal(f.connects, 1);
  await Promise.all([f.session.close(), f.session.close()]); assert.equal(f.closed, 1);
  await assert.rejects(f.session.open(), { code: 'inbox_database_stopped' });
});

test('an existing owner or either read-only variable prevents a ready session', async () => {
  const occupied = fixture(); occupied.owner = 99;
  await assert.rejects(occupied.session.open(), { code: 'inbox_consumer_owner_exists' });
  assert(!occupied.calls.some(sql => sql.includes('FROM WhatsappInboxImports'))); await occupied.session.close();
  for (const key of ['readOnly', 'superReadOnly']) {
    const f = fixture(); f[key] = 1;
    await assert.rejects(f.session.open(), { code: 'inbox_database_writer_required' });
    assert(!f.calls.some(sql => sql.includes('GET_LOCK'))); await f.session.close();
  }
});

test('an idle driver error invalidates the session before any subsequent SQL or lease', async () => {
  const f = fixture(); await f.session.open(); const count = f.calls.length;
  f.connection.connection.emit('error', Object.assign(Error('synthetic idle disconnect'), { code: 'ECONNRESET' }));
  await assert.rejects(f.session.assertOwnership(), { code: 'inbox_database_session_unavailable' });
  assert.equal(f.calls.length, count); await f.session.close();
});

test('SIGTERM during connect cannot acquire ownership or begin a poll', async () => {
  let stopped = false, resolveConnect;
  const f = fixture({ isStopping: () => stopped, connect: () => new Promise(resolve => { resolveConnect = resolve; }) });
  const opening = f.session.open(); stopped = true; resolveConnect(f.connection);
  await assert.rejects(opening, { code: 'inbox_database_stopped' });
  assert.equal(f.calls.length, 0); await f.session.close(); assert.equal(f.closed, 1);
});

test('repeated unavailable connections require separate supervisor starts and never retry inside a session', async () => {
  let attempts = 0;
  for (let restart = 0; restart < 3; restart++) {
    const session = createInboxDatabaseSession({ connect: async () => { attempts++; throw Error('PRIVATE TARGET'); }, tables: [] });
    await assert.rejects(session.open(), error => error.code === 'inbox_database_connection_unavailable' && !error.message.includes('PRIVATE'));
    await assert.rejects(session.open(), { code: 'inbox_database_connection_unavailable' }); await session.close();
  }
  assert.equal(attempts, 3);
});

test('unresponsive ownership checks and shutdown are bounded and destroy only the dedicated connection', async () => {
  const check = fixture({ checkTimeoutMs: 5 }); check.connection.execute = () => new Promise(() => {});
  await assert.rejects(check.session.open(), { code: 'inbox_database_session_unavailable' });
  assert.equal(check.destroyed, 1); await check.session.close();
  const closing = fixture({ closeTimeoutMs: 5 }); await closing.session.open();
  closing.connection.end = () => new Promise(() => {}); await closing.session.close(); assert.equal(closing.destroyed, 1);
});

test('ownership is checked before pending, lease, clinical import and ACK; no uncertain import is replayed', async () => {
  for (const failureAt of [1, 2, 3, 4]) {
    const calls = []; let guards = 0, imports = 0;
    const client = { request: async (method, route) => {
      calls.push(route);
      if (route === '/pending') return { status: 200, data: { automaticActionsAllowed: false, receipts: [{ receipt: 'receipt' }] } };
      if (route === '/lease') return { status: 200, data: { receipt: 'receipt', lease: 'lease', rawBase64: Buffer.from('FICTITIOUS').toString('base64') } };
      return { status: 200, data: { businessProcessed: true } };
    } };
    await assert.rejects(pollOnce({}, client, { env: {}, requiresScoped: true, loadConfiguration: () => ({ scopes: [] }), publish: () => {},
      assertDatabaseOwnership: async () => { if (++guards === failureAt) throw Object.assign(Error('inbox_database_owner_lost'), { inboxDatabaseUnavailable: true }); },
      importScoped: async () => { imports++; return { importReceipt: 'committed' }; },
    }), /inbox_database_owner_lost/);
    assert.equal(calls.includes('/confirm'), false);
    assert.equal(calls.includes('/lease'), failureAt >= 3);
    assert.equal(imports, failureAt === 4 ? 1 : 0);
    assert.equal(calls.filter(route => route === '/defer').length, failureAt >= 3 ? 1 : 0);
  }
});

function mainFixture() {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const f = fixture(), signals = new EventEmitter(); let connects = 0, requests = 0, clientsClosed = 0;
  signals.stderr = { write() {} }; signals.env = {};
  const dependencies = {
    '../lib/whatsappInboxClient': { createInboxClient: () => ({ close: () => { clientsClosed++; }, request: async () => {
      requests++; f.duringPending?.(); return { status: 200, data: { automaticActionsAllowed: false, receipts: [] } };
    } }), clientFiles: () => ({}) },
    '../lib/whatsappInboxImport': { importLease: () => assert.fail('No clinical import expected') },
    '../lib/whatsappInboxScopes': { configuration: () => ({ scopes: [] }) },
    '../lib/whatsappInboxHealth': { publish() {} },
    '../lib/databaseTlsConfig': require('../../lib/databaseTlsConfig'),
    '../lib/whatsappInboxDatabaseSession': { createInboxDatabaseSession },
    'node:net': require('node:net'),
    'mysql2/promise': { createConnection: async () => { connects++; if (f.connectError) throw Error('PRIVATE TARGET'); return f.connection; } },
  };
  const filename = path.resolve(__dirname, '../whatsapp-inbox-consumer.js'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, Buffer, Date, process: signals, setTimeout, clearTimeout,
    require: name => { assert(Object.hasOwn(dependencies, name), 'Unexpected runtime dependency'); return dependencies[name]; } }, { filename });
  const env = { RUNTIME_NAMESPACE: 'staging', WHATSAPP_INBOX_CONSUMER_ENABLED: 'true', DB_NAME: 'clinicaclick',
    DB_HOST: 'localhost', DB_USERNAME: 'synthetic', DB_PASSWORD: 'synthetic' };
  return { f, signals, run: () => module.exports.main(env), counts: () => ({ connects, requests, clientsClosed }) };
}

test('actual consumer drains and exits on database loss instead of keeping an alive dead polling loop', async () => {
  const runtime = mainFixture(); runtime.f.duringPending = () => { runtime.f.readError = true; };
  await assert.rejects(runtime.run(), { code: 'inbox_database_session_unavailable' });
  assert.deepEqual(runtime.counts(), { connects: 1, requests: 1, clientsClosed: 1 });
  assert.equal(runtime.f.closed, 1); assert.equal(runtime.signals.listenerCount('SIGTERM'), 0);
});

test('actual consumer never polls for another owner and SIGTERM closes a ready session without failure', async () => {
  const occupied = mainFixture(); occupied.f.owner = 99;
  await assert.rejects(occupied.run(), { code: 'inbox_consumer_owner_exists' });
  assert.equal(occupied.counts().requests, 0); assert.equal(occupied.f.closed, 1);
  const stopped = mainFixture(); stopped.f.duringPending = () => stopped.signals.emit('SIGTERM');
  await stopped.run(); assert.equal(stopped.counts().requests, 1); assert.equal(stopped.f.closed, 1);
  assert.equal(stopped.signals.listenerCount('SIGTERM'), 0);
});

test('actual unavailable consumer startup returns failure to the supervisor without retrying or leasing', async () => {
  const runtime = mainFixture(); runtime.f.connectError = true;
  await assert.rejects(runtime.run(), { code: 'inbox_database_connection_unavailable' });
  assert.deepEqual(runtime.counts(), { connects: 1, requests: 0, clientsClosed: 1 });
});
