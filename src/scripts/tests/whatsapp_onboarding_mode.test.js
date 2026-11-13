'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const { DataTypes: D } = require('sequelize');
const C = require('../../services/whatsappAuthorizationState.contract');
const { createService } = require('../../services/whatsappAuthorizationState.service');
const { createService: gateway } = require('../../services/whatsappOnboardingGateway.service');
const migrationName = '20261113010000-add-whatsapp-onboarding-mode.js';

function fixture() {
  const at = new Date('2026-11-13T10:00:00.000Z'), key = Buffer.alloc(32, 7);
  const actor = { userId: 501, sessionRef: randomUUID(), sessionExpiresAt: at.getTime() / 1000 + 3600 };
  const rows = new Map(), events = [], writes = [], sessions = [];
  let tail = Promise.resolve();
  const models = {
    sequelize: { transaction: (options, work) => {
      const run = tail.then(async () => {
        const before = structuredClone(rows), auditLength = events.length, writeLength = writes.length;
        try { return await work({ LOCK: { UPDATE: 'UPDATE' } }); }
        catch (error) { rows.clear(); for (const [id, row] of before) rows.set(id, row); events.length = auditLength; writes.length = writeLength; throw error; }
      });
      tail = run.catch(() => {}); return run;
    } },
    Clinica: { findAll: async () => [{ id_clinica: 71, grupoClinicaId: null }], findByPk: async () => ({ id_clinica: 71, grupoClinicaId: null }) },
    UsuarioClinica: { findAll: async () => [{ id_clinica: 71 }] },
    MetaScopeBlock: { findOne: async () => null },
    WhatsappAuthorizationState: {
      findByPk: async id => structuredClone(rows.get(id)), count: async () => 0,
      create: async row => { assert(!rows.has(row.request_id)); rows.set(row.request_id, structuredClone(row)); writes.push('create'); },
      update: async (values, options) => {
        if (values.code_hash && [...rows.values()].some(row => row.request_id !== options.where.request_id && row.code_hash === values.code_hash)) {
          throw Object.assign(Error('FICTITIOUS_DATABASE_DETAIL'), { name: 'SequelizeUniqueConstraintError' });
        }
        Object.assign(rows.get(options.where.request_id), structuredClone(values)); writes.push('update');
      },
    },
  };
  const make = () => createService({ models, now: () => new Date(at), config: () => ({ key: Buffer.from(key) }),
    sessions: { verifyReference: async (input, options) => { sessions.push(options); assert.equal(options.requireEmail, true); } },
    audit: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async row => events.push(row) } });
  const input = () => ({ ...actor, requestId: randomUUID(), scope: { type: 'clinic', id: 71 } });
  const ref = requestId => ({ ...actor, requestId });
  return { rows, events, writes, sessions, input, ref, make, actor, key, at };
}

test('Mode is an optional exact begin intent; it is never accepted on claim/status/cancel or as a policy', () => {
  const f = fixture();
  assert.equal(Object.hasOwn(C.request(f.input(), 'issue'), 'mode'), false);
  for (const mode of ['cloud_api', 'coexistence']) assert.equal(C.request({ ...f.input(), mode }, 'issue').mode, mode);
  for (const mode of [null, undefined, '', 'Cloud_API', 'meta-app-companion-v1', false, {}, ['coexistence']]) {
    assert.throws(() => C.request({ ...f.input(), mode }, 'issue'), { code: 'whatsapp_authorization_invalid' });
  }
  for (const operation of ['status', 'cancel', 'assertClaimActive']) assert.throws(() => C.request({ ...f.ref(randomUUID()), mode: 'coexistence' }, operation));
  assert.throws(() => C.request({ ...f.ref(randomUUID()), state: 's'.repeat(43), code: 'FICTITIOUS_CODE', mode: 'coexistence' }, 'claim'));
  assert.throws(() => C.request({ ...f.input(), mode: 'coexistence', providerGrantPolicy: 'meta-app-companion-v1' }, 'issue'));
});

test('NULL mode retains frozen v1/v2/v3 contexts and state MACs; v4 pins mode, role and replacement', () => {
  const row = { request_id: '11111111-1111-4111-8111-111111111111', user_id: 501,
    session_ref: '22222222-2222-4222-8222-222222222222', session_expires_at: new Date('2030-01-01T01:00:00Z'),
    scope_type: 'clinic', scope_id: 71, original_clinic_ids: [71], scope_digest: 'a'.repeat(64),
    created_at: new Date('2030-01-01T00:00:00Z'), expires_at: new Date('2030-01-01T00:10:00Z') };
  const replacement = { channel_role: 'primary', replacement_asset_id: 382,
    replacement_authorization_id: '33333333-3333-4333-8333-333333333333', replacement_phone_digest: 'b'.repeat(64) };
  const cases = [
    [row, '58e0e740b00632d6faa1dcce19946c20a50274e9f75776df5c6dd4abcdfc09bb'],
    [{ ...row, channel_role: 'secondary' }, 'fdc73494aa36c84cfbbd5e8bd43f19632e821c069b5a3a6a9565e59af9e79ba2'],
    [{ ...row, ...replacement }, '208bebca58a1bc140fb5f58f5ede1a80c9281c16fbb65199eebb5db352afa15a'],
  ];
  for (const [legacy, expected] of cases) {
    assert.equal(C.contextDigest(legacy), expected);
    assert.equal(C.contextDigest({ ...legacy, onboarding_mode: null }), expected);
    const key = Buffer.alloc(32, 7);
    assert.equal(C.stateFor(key, { ...legacy, context_digest: expected }), C.stateFor(key, { ...legacy, onboarding_mode: null, context_digest: C.contextDigest({ ...legacy, onboarding_mode: null }) }));
    assert.notEqual(C.contextDigest({ ...legacy, onboarding_mode: 'cloud_api' }), expected);
    assert.notEqual(C.contextDigest({ ...legacy, onboarding_mode: 'coexistence' }), C.contextDigest({ ...legacy, onboarding_mode: 'cloud_api' }));
  }
  const current = { ...row, ...replacement, onboarding_mode: 'coexistence' };
  for (const changed of [{ channel_role: 'secondary' }, { replacement_asset_id: 383 }, { replacement_phone_digest: 'c'.repeat(64) }]) {
    assert.notEqual(C.contextDigest({ ...current, ...changed }), C.contextDigest(current));
  }
  assert.throws(() => C.contextDigest({ ...row, onboarding_mode: 'unknown' }), { code: 'whatsapp_authorization_unavailable' });
});

test('Mode survives issue replay, service reload, claim, resume and cancellation without changing history', async () => {
  for (const mode of ['cloud_api', 'coexistence']) {
    const f = fixture(), input = { ...f.input(), mode }, issued = await f.make().issue(input);
    assert.equal(issued.mode, mode); assert.equal(f.rows.get(input.requestId).onboarding_mode, mode);
    const before = structuredClone(f.rows.get(input.requestId));
    assert.deepEqual(await f.make().issue(input), issued); assert.equal(f.events.length, 1); assert.equal(f.writes.length, 1);
    const local = await f.make().status(f.ref(input.requestId)); assert.equal(local.mode, mode);
    assert.deepEqual(f.rows.get(input.requestId), before);
    const claimed = await f.make().claim({ ...f.ref(input.requestId), state: issued.state, code: 'FICTITIOUS_CODE_' + mode });
    assert.equal(claimed.mode, mode); assert.equal(claimed.mayExchange, true);
    assert.equal((await f.make().assertClaimActive(f.ref(input.requestId))).mode, mode);
    assert.equal((await f.make().resume(f.ref(input.requestId))).mode, mode);
    assert.equal((await f.make().cancel(f.ref(input.requestId))).mode, mode);
    assert.equal((await f.make().status(f.ref(input.requestId))).status, 'cancelled');
    assert.equal(f.rows.get(input.requestId).onboarding_mode, mode);
    assert.deepEqual(f.events.map(row => row.reason), ['state_issued', 'state_claimed', 'state_cancelled']);
  }
});

test('Concurrent issue cannot change, add or omit the mode of the winning immutable attempt', async () => {
  const f = fixture(), input = f.input();
  const results = await Promise.allSettled([f.make().issue({ ...input, mode: 'coexistence' }), f.make().issue({ ...input, mode: 'cloud_api' })]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'whatsapp_authorization_conflict');
  const saved = structuredClone(f.rows.get(input.requestId));
  await assert.rejects(f.make().issue(input), { code: 'whatsapp_authorization_conflict' });
  assert.deepEqual(f.rows.get(input.requestId), saved); assert.equal(f.events.length, 1);
  const legacy = fixture(), old = legacy.input(); await legacy.make().issue(old);
  assert.equal(legacy.rows.get(old.requestId).onboarding_mode, null);
  assert.equal(Object.hasOwn(await legacy.make().status(legacy.ref(old.requestId)), 'mode'), false);
  await assert.rejects(legacy.make().issue({ ...old, mode: 'coexistence' }), { code: 'whatsapp_authorization_conflict' });
});

test('Stored mode tampering fails the existing signed-context guard before claim or dispatch', async () => {
  const f = fixture(), input = { ...f.input(), mode: 'coexistence' }, issued = await f.make().issue(input);
  for (const changed of ['cloud_api', null, 'unrecognized']) {
    f.rows.get(input.requestId).onboarding_mode = changed;
    await assert.rejects(f.make().status(f.ref(input.requestId)), { code: 'whatsapp_authorization_unavailable' });
    await assert.rejects(f.make().claim({ ...f.ref(input.requestId), state: issued.state, code: 'FICTITIOUS_NEVER_EXCHANGED' }), { code: 'whatsapp_authorization_unavailable' });
    assert.equal(f.rows.get(input.requestId).state, 'awaiting');
  }
  assert.equal(f.events.length, 1); assert.equal(f.writes.length, 1);
});

test('Public begin/status/finish/cancel DTO carries only the saved optional mode and never authorizes sending', async () => {
  const f = fixture(), calls = [], states = f.make();
  const remote = (status, extra = {}) => ({ status, accessBlocked: false, configurationChanged: false, expired: false, ...extra });
  const api = gateway({ states, guard() {}, broker: {
    begin: async local => { calls.push(local); return remote('awaiting', { authorization: { appId: '101', configId: '102', redirectUri: 'https://example.invalid/' } }); },
    status: async local => { calls.push(local); return remote(local.status === 'claimed' ? 'staged' : 'awaiting', { candidate: { wabaId: '301', phoneId: '401' } }); },
    finish: async local => { calls.push(local); return remote('staged', { candidate: { wabaId: '301', phoneId: '401' } }); },
    abort: async local => { calls.push(local); return remote('aborted'); },
  } });
  const input = { ...f.input(), mode: 'coexistence' }, begin = await api.begin(input);
  assert.equal(begin.mode, 'coexistence'); assert.equal(begin.authorizationStatus, 'awaiting_authorization');
  for (const result of [await api.status(f.ref(input.requestId)), await api.finish({ ...f.ref(input.requestId), state: begin.authorization.state,
    code: 'FICTITIOUS_GATEWAY_CODE', wabaId: '301', phoneId: '401' }), await api.cancel(f.ref(input.requestId))]) {
    assert.equal(result.mode, 'coexistence'); assert.equal(result.connected, false);
    for (const key of ['scopeDigest', 'clinicSetDigest', 'context_digest', 'onboarding_mode', 'providerGrantPolicy', 'candidate', 'userId', 'sessionRef']) assert.equal(Object.hasOwn(result, key), false);
  }
  assert(calls.every(row => row.mode === 'coexistence'));
  const legacy = await api.begin(f.input()); assert.equal(Object.hasOwn(legacy, 'mode'), false);
});

test('Nullable mode model/migration and exact schema pin preserve signed data during rollback', async () => {
  let attrs; require('../../../models/whatsappauthorizationstate')({ define: (name, fields) => { attrs = fields; } }, D);
  assert.deepEqual(attrs.onboarding_mode.type.values, ['cloud_api', 'coexistence']); assert.equal(attrs.onboarding_mode.allowNull, true); assert.equal(attrs.onboarding_mode.defaultValue, null);
  const migration = require('../../../migrations/' + migrationName), calls = [];
  const qi = { addColumn: async (...args) => calls.push(['add', ...args]), removeColumn: async (...args) => calls.push(['remove', ...args]),
    sequelize: { query: async sql => { assert.equal(sql, 'SELECT COUNT(*) AS n FROM WhatsappAuthorizationStates WHERE onboarding_mode IS NOT NULL'); return [[{ n: 0 }]]; } } };
  await migration.up(qi, D); assert.deepEqual(calls[0].slice(0, 3), ['add', 'WhatsappAuthorizationStates', 'onboarding_mode']);
  assert.equal(calls[0][3].allowNull, true); assert.equal(calls[0][3].defaultValue, null);
  await migration.down(qi); assert.deepEqual(calls[1], ['remove', 'WhatsappAuthorizationStates', 'onboarding_mode']);
  qi.sequelize.query = async () => [[{ n: 1 }]];
  await assert.rejects(migration.down(qi), /Preserve signed WhatsApp onboarding modes/); assert.equal(calls.length, 2);
  const schema = require('../../../ops/security/schema-contract.json');
  assert.equal(schema.migrations.find(row => row.name === migrationName).sha256,
    createHash('sha256').update(fs.readFileSync(require.resolve('../../../migrations/' + migrationName))).digest('hex'));
  assert.deepEqual(schema.tables.WhatsappAuthorizationStates.columns.find(row => row.COLUMN_NAME === 'onboarding_mode'), {
    COLUMN_NAME: 'onboarding_mode', COLUMN_TYPE: "enum('cloud_api','coexistence')", IS_NULLABLE: 'YES', COLUMN_DEFAULT: null,
    EXTRA: '', CHARACTER_SET_NAME: 'ascii', COLLATION_NAME: 'ascii_bin',
  });
});
