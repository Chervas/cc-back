'use strict';

require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const patientReads = require('../../services/platformAudit.patientReads');
const { pack } = require('../../../services/platform-audit/src/event');
const { createReviewCareAudit, current } = require('../../services/reviewCareAudit.service');

const PRIVATE = 'FICTITIOUS_PRIVATE_DATE_SNAPSHOT_NOTE_SQL_TOKEN';
const header = 'Bearer FICTITIOUS_ORIGINAL_TOKEN';
const metadata = patientIds => ({ clinicIds: [71], patientIds, resultCount: patientIds.length, includesSensitive: true });
const closed = status => error => error.status === status && !JSON.stringify({ message: error.message,
  code: error.code, cause: error.cause, stack: error.stack }).includes(PRIVATE) && !error.cause;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(options = {}) {
  const sessionId = randomUUID();
  const state = { rows: [], work: 0, checks: 0, permissions: 0, transactions: 0, flag: 'true',
    sessionValid: true, permissionValid: true, pending: 0, captureRequests: [], ...options };
  const req = { userData: { userId: 501 }, authSession: { id: sessionId }, headers: { authorization: header },
    body: { note: PRIVATE }, query: { date: PRIVATE } };
  const sessions = { bearer(value) { assert.equal(value, header); return value.slice(7); }, async verify(token) {
    state.checks++; assert.equal(token, header.slice(7));
    if (!state.sessionValid) throw Object.assign(Error(PRIVATE), { name: 'TokenExpiredError' });
    await state.onVerify?.();
    return state.claims || { userId: 501, sessionVersion: 1, jti: sessionId };
  } };
  const repository = { async health() { return { pending: state.pending, oldestAgeSeconds: state.age || 0 }; },
    async append(row, { transaction } = {}) {
      pack(row); await state.beforeAppend?.(row);
      (transaction || state.rows).push(row);
    } };
  const capture = patientReads.createCapture({ repository, enabled: () => state.flag,
    verifySession: async request => { state.captureRequests.push(request); },
    transaction: async callback => {
      state.transactions++;
      const batch = []; await callback(batch); await state.beforeCommit?.();
      state.rows.push(...batch); await state.afterCommit?.();
    } });
  const service = createReviewCareAudit({ capture, sessions });
  const revalidate = async () => {
    state.permissions++; await state.onPermission?.();
    if (!state.permissionValid) throw Object.assign(Error(PRIVATE), { status: 403 });
  };
  const run = (overrides = {}) => service.run({ req, revalidate, work: async () => {
    state.work++; await state.onWork?.(); return { value: { snapshot: PRIVATE }, metadata: metadata([901]) };
  }, ...overrides });
  return { state, req, sessions, capture, service, revalidate, run };
}

test('patient.list reuses durable capture and stores only IDs/counts, never the calculated value or request', async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(result, { snapshot: PRIVATE }); assert.equal(f.state.work, 1);
  assert.deepEqual(f.state.rows.map(row => [row.action, row.stage]), [['patient.list', 'attempted'], ['patient.list', 'completed']]);
  const row = f.state.rows[1];
  assert.deepEqual(row.patientIds, ['901']); assert.deepEqual(row.clinicIds, ['71']);
  assert.equal(row.resultCount, 1); assert.equal(row.includesSensitive, true);
  assert.equal(row.actor.id, '501'); assert.equal(row.sessionRef, f.req.authSession.id);
  assert.equal(f.state.transactions, 1); assert.equal(f.state.permissions, 4);
  assert(!JSON.stringify(f.state.rows).includes(PRIVATE)); assert(!JSON.stringify(f.state.rows).includes(header));
  assert(f.state.captureRequests.every(request => request !== f.req));
});

test('the value waits for transaction completion and all checks; work is never repeated', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ beforeCommit: async () => { entered.resolve(); await release.promise; } });
  let returned = false; const running = f.run().then(value => { returned = true; return value; });
  await entered.promise;
  assert.equal(returned, false); assert.equal(f.state.work, 1);
  assert.deepEqual(f.state.rows.map(row => row.stage), ['attempted']);
  release.resolve(); assert.deepEqual(await running, { snapshot: PRIVATE });
  assert.equal(returned, true); assert.equal(f.state.work, 1);
});

test('OFF still verifies the original session and permissions before and after work, without audit SQL', async () => {
  for (const flag of [undefined, '', 'false']) {
    const f = fixture({ flag }); assert.deepEqual(await f.run(), { snapshot: PRIVATE });
    assert.equal(f.state.checks, 2); assert.equal(f.state.permissions, 2);
    assert.equal(f.state.transactions, 0); assert.deepEqual(f.state.rows, []);
    f.state.onWork = () => { f.state.permissionValid = false; };
    await assert.rejects(f.run(), closed(403)); assert.equal(f.state.transactions, 0);
    const expired = fixture({ flag, onWork() { this.sessionValid = false; } });
    await assert.rejects(expired.run(), closed(401));
  }
});

test('missing revalidation, unauthenticated requests and initial denial cannot perform work', async () => {
  const f = fixture();
  await assert.rejects(f.run({ revalidate: undefined }), closed(503));
  for (const req of [undefined, {}, { userData: { userId: 0 }, headers: { authorization: header } },
    { userData: { userId: { toString: () => '501' } }, headers: { authorization: header } },
    { userData: { userId: 501 }, headers: {} }]) await assert.rejects(f.run({ req }), closed(401));
  assert.equal(f.state.work, 0);
  for (const flag of ['true', 'false']) {
    const denied = fixture({ flag, permissionValid: false });
    await assert.rejects(denied.run(), closed(403)); assert.equal(denied.state.work, 0);
  }
});

test('expiry or permission revocation during commit discards prepared content after durable completion', async () => {
  for (const kind of ['session', 'permission']) {
    const f = fixture({ afterCommit() { this[kind === 'session' ? 'sessionValid' : 'permissionValid'] = false; } });
    await assert.rejects(f.run(), closed(kind === 'session' ? 401 : 403));
    assert.equal(f.state.work, 1);
    assert.deepEqual(f.state.rows.map(row => row.stage), ['attempted', 'completed', 'discarded']);
    assert.deepEqual(f.state.rows.at(-1).patientIds, []);
    assert.equal(f.state.rows.at(-1).reason, 'access_changed');
  }
});

test('failed completion or discard acknowledgements close with sanitized 503 and do not repeat the read', async () => {
  const failed = fixture({ beforeCommit: () => { throw Error(PRIVATE); } });
  await assert.rejects(failed.run(), closed(503)); assert.equal(failed.state.work, 1);
  assert(!failed.state.rows.some(row => row.outcome === 'success'));
  const discard = fixture({ afterCommit() { this.permissionValid = false; },
    beforeAppend: row => { if (row.stage === 'discarded') throw Error(PRIVATE); } });
  await assert.rejects(discard.run(), closed(503)); assert.equal(discard.state.work, 1);
});

test('admission, malformed gate and provider failures never expose raw errors or allow retries', async () => {
  for (const options of [{ pending: 10000 }, { age: 3600 }, { flag: 'yes' },
    { beforeAppend: () => { throw Error(PRIVATE); } }]) {
    const f = fixture(options); await assert.rejects(f.run(), closed(503)); assert.equal(f.state.work, 0);
  }
  const f = fixture();
  await assert.rejects(f.run({ work: async () => { throw Error(PRIVATE); } }), closed(503));
});

test('exact metadata and existing bounds are validated even while capture is OFF', async () => {
  const invalid = [undefined, { ...metadata([901]), notes: PRIVATE }, { ...metadata([901]), date: '2026-11-12' },
    { ...metadata([901]), clinicIds: [] }, { ...metadata([]), clinicIds: [], includesSensitive: true },
    { ...metadata([901]), resultCount: -1 }, { ...metadata([901]), resultCount: 1000000001 },
    { ...metadata([901]), includesSensitive: 1 }, { ...metadata([901]), patientIds: [2147483648] },
    { ...metadata([901]), patientIds: ['01'] }, { ...metadata([901]), patientIds: [{ id: 901 }] },
    metadata(Array.from({ length: 10001 }, (_, index) => index + 1)),
    { ...metadata([]), clinicIds: Array.from({ length: 101 }, (_, index) => index + 1) }];
  for (const flag of ['true', 'false']) for (const value of invalid) {
    const f = fixture({ flag });
    await assert.rejects(f.run({ work: async () => ({ value: PRIVATE, metadata: value }) }), closed(503));
    assert(!f.state.rows.some(row => row.outcome === 'success'));
  }
});

test('metadata is copied before asynchronous checks and empty/undefined values remain valid', async () => {
  const source = metadata([903, 901, 903]), f = fixture();
  f.state.onPermission = () => { if (f.state.permissions === 2) { source.patientIds.push(999); source.clinicIds[0] = 72; } };
  const result = await f.run({ work: async () => ({ value: undefined, metadata: source }) });
  assert.equal(result, undefined); assert.deepEqual(f.state.rows[1].patientIds, ['901', '903']);
  assert.deepEqual(f.state.rows[1].clinicIds, ['71']);
  const empty = fixture(); assert.equal(await empty.run({ work: async () => ({ value: null,
    metadata: { clinicIds: [], patientIds: [], resultCount: 0, includesSensitive: false } }) }), null);
});

test('mutating the original req during reads cannot change the captured bearer, actor or session', async () => {
  const f = fixture(), originalSession = f.req.authSession.id;
  f.state.onWork = () => { f.req.headers.authorization = 'Bearer FICTITIOUS_OTHER_TOKEN';
    f.req.userData.userId = 999; f.req.authSession.id = randomUUID(); };
  assert.deepEqual(await f.run(), { snapshot: PRIVATE });
  assert(f.state.rows.every(row => row.actor.id === '501' && row.sessionRef === originalSession));
  assert(f.state.captureRequests.every(request => request.headers.authorization === header
    && request.userData.userId === 501 && request.authSession.id === originalSession));
});

test('a different verified actor or session is denied rather than inventing an attribution', async () => {
  for (const claims of [{ userId: 999, sessionVersion: 1, jti: randomUUID() }, { userId: 501, sessionVersion: 1, jti: randomUUID() }]) {
    const f = fixture({ claims }); await assert.rejects(f.run(), closed(401)); assert.equal(f.state.work, 0);
  }
});

test('parallel captures on one authenticated req also preserve a surrounding patient capture', async () => {
  const f = fixture(), both = deferred(), release = deferred(); let started = 0;
  const run = id => f.run({ work: async () => {
    if (++started === 2) both.resolve(); await release.promise;
    return { value: id, metadata: metadata([id]) };
  } });
  const outer = f.capture.run('patient.detail.read', f.req, async (req, res) => {
    const pending = Promise.all([run(901), run(902)]);
    await both.promise; release.resolve(); assert.deepEqual(await pending, [901, 902]);
    patientReads.track(req, metadata([903])); res.json({ opaque: true });
  });
  assert.equal((await outer).status, 200);
  assert.equal(new Set(f.state.rows.map(row => row.correlationId)).size, 3);
  assert.deepEqual(f.state.rows.filter(row => row.outcome === 'success').map(row => row.patientIds[0]).sort(), ['901', '902', '903']);
  patientReads.track(f.req, () => assert.fail('outer WeakMap context must be cleaned'));
});

test('only exact 200 from a completed single callback can release a value', async () => {
  const f = fixture();
  for (const status of [201, 204, 400, 500, undefined]) {
    const capture = { async run(action, req, callback) {
      assert.equal(action, 'patient.list'); let body;
      const sink = { status() { return this; }, json(value) { body = value; } };
      await callback(req, sink); return { status, body };
    } };
    const service = createReviewCareAudit({ capture, sessions: f.sessions });
    await assert.rejects(service.run({ req: f.req, revalidate: f.revalidate,
      work: async () => ({ value: PRIVATE, metadata: metadata([901]) }) }), closed(503));
  }
  const skipped = createReviewCareAudit({ capture: { run: async () => ({ status: 200, body: PRIVATE }) }, sessions: f.sessions });
  await assert.rejects(skipped.run({ req: f.req, revalidate: f.revalidate, work: () => assert.fail('not called') }), closed(503));
  let work = 0;
  const twice = createReviewCareAudit({ sessions: f.sessions, capture: { async run(_, req, callback) {
    const sink = { status() { return this; }, json() {} }; await callback(req, sink); await callback(req, sink);
  } } });
  await assert.rejects(twice.run({ req: f.req, revalidate: f.revalidate, work: async () => {
    work++; return { value: PRIVATE, metadata: metadata([901]) };
  } }), closed(503)); assert.equal(work, 1);
});

test('default capture lazily uses the injected existing repository model and SQL transaction', async () => {
  const f = fixture(), rows = []; let transactions = 0, modelReads = 0;
  const sequelize = { async transaction(callback) {
    transactions++; const batch = []; await callback(batch); rows.push(...batch);
  } };
  const model = { sequelize, count: async () => 0, min: async () => null,
    async create(row, { transaction } = {}) { (transaction || rows).push(row); } };
  const db = { sequelize, get PlatformAuditEvent() { modelReads++; return model; } };
  const service = createReviewCareAudit({ db, sessions: f.sessions });
  assert.equal(modelReads, 0); assert(current(), 'singleton construction also remains lazy');
  const previous = process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED;
  process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED = 'true';
  try {
    assert.equal(await service.run({ req: f.req, revalidate: f.revalidate,
      work: async () => ({ value: 42, metadata: metadata([901]) }) }), 42);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED;
    else process.env.PLATFORM_AUDIT_PATIENT_READS_ENABLED = previous;
  }
  assert.equal(transactions, 1); assert.equal(rows.length, 2); assert(modelReads > 0);
  assert(!JSON.stringify(rows).includes(PRIVATE));
  assert.deepEqual(JSON.parse(rows[1].body).patientIds, ['901']);
});
