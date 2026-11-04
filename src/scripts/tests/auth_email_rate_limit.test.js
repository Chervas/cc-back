'use strict';
// No environment bootstrap, SQL, network or real email delivery.
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op } = require('sequelize');
const C = require('../../services/authEmailChallenge.contract');
const { createService } = require('../../services/authEmailChallenge.service');

function fixture(intents = []) {
  let at = Date.UTC(2030, 0, 1, 12);
  const user = { id_usuario: 17, estado_cuenta: 'activo', es_provisional: false,
    email_usuario: 'offline@example.invalid', password_usuario: 'FICTITIOUS_HASH' };
  const state = { rows: [], mails: 0, events: [], creates: 0, hourlyReads: 0 };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const attach = fields => {
    const row = { challenge_id: '9d48377c-5cae-47e4-806d-7d80423cf5ab', user_id: user.id_usuario,
      state: 'pending', sends: 1, attempts: 0, created_at: new Date(at - 100000),
      last_sent_at: new Date(at - 100000), expires_at: new Date(at + 300000),
      absolute_expires_at: new Date(at + 600000), credential_binding: 'a'.repeat(64), email_hash: C.emailHash(user.email_usuario),
      challenge_hash: C.challengeHash('A'.repeat(43)), code_hash: C.codeHash(Buffer.alloc(32, 7), '9d48377c-5cae-47e4-806d-7d80423cf5ab', '654321'),
      ...fields };
    row.update = async patch => Object.assign(row, patch); state.rows.push(row); return row;
  };
  intents.forEach((value, i) => attach({ challenge_id: 'offline-intent-' + i,
    created_at: new Date(at - value.ageMs), last_sent_at: new Date(at - value.ageMs), ...value }));
  const matching = options => state.rows.filter(row => row.user_id === options.where.user_id
    && row.last_sent_at >= options.where.last_sent_at[Op.gte]);
  const models = {
    sequelize: { transaction: async (options, work) => work(transaction) },
    Usuario: { findByPk: async id => id === user.id_usuario ? user : null },
    AuthEmailChallenge: {
      findOne: async options => options.where.challenge_hash
        ? state.rows.find(row => row.challenge_hash === options.where.challenge_hash)
        : state.rows.filter(row => row.user_id === options.where.user_id).sort((a, b) => b.created_at - a.created_at)[0] || null,
      findByPk: async id => state.rows.find(row => row.challenge_id === id),
      sum: async (field, options) => matching(options).reduce((n, row) => n + row.sends, 0),
      findAll: async options => { state.hourlyReads++; return matching(options).map(row => ({ sends: row.sends, last_sent_at: row.last_sent_at })); },
      update: async (patch, options) => { for (const row of state.rows) if (row.user_id === options.where.user_id
        && options.where.state[Op.in].includes(row.state)) Object.assign(row, patch); },
      create: async values => { state.creates++; return attach(values); },
    },
  };
  const service = createService({ models, now: () => new Date(at), config: () => ({ mode: 'enforce', key: Buffer.alloc(32, 7) }),
    sessions: { credentialBinding: () => 'a'.repeat(64), authenticated: async () => assert.fail('unexpected session issuance') },
    audit: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async value => { state.events.push(value); } },
    queueEmail: async () => { state.mails++; return { emailMessage: { id: 11, status: 'queued' } }; },
  });
  return { user, state, service, attach, advance: ms => { at += ms; } };
}

test('rapid duplicate sign-in reports the real cooldown without another code or challenge mutation', async () => {
  const f = fixture([{ ageMs: 32, state: 'used' }]);
  const before = f.state.rows[0].last_sent_at.getTime();
  await assert.rejects(f.service.begin(f.user), { code: 'auth_email_rate_limited', status: 429, retryAfterSeconds: 60 });
  f.advance(34568);
  await assert.rejects(f.service.begin(f.user), { code: 'auth_email_rate_limited', retryAfterSeconds: 26 });
  assert.equal(f.state.rows[0].last_sent_at.getTime(), before); assert.equal(f.state.rows[0].state, 'used');
  assert.equal(f.state.creates, 0); assert.equal(f.state.mails, 0);
  assert(f.state.events.every(event => event.reason === 'rate_limited'));
});

test('hourly quota weights whole intents in all states and waits for enough sends to leave the hour', async () => {
  const f = fixture([{ ageMs: 3500000, sends: 1, state: 'used' }, { ageMs: 3400000, sends: 3, state: 'revoked' },
    { ageMs: 3000000, sends: 3, state: 'expired' }]);
  // Seven sends: expiry of only the oldest one leaves six, still over the cap.
  await assert.rejects(f.service.begin(f.user), { code: 'auth_email_rate_limited', retryAfterSeconds: 201 });
  assert.equal(f.state.creates, 0); assert.equal(f.state.mails, 0);
});

test('cooldown and hourly quota combine, and inclusive hour boundary does not admit a premature retry', async () => {
  const f = fixture([{ ageMs: 3600000, sends: 3 }, { ageMs: 20000, sends: 2 }]);
  await assert.rejects(f.service.begin(f.user), { code: 'auth_email_rate_limited', retryAfterSeconds: 40 });
  f.advance(40000);
  const result = await f.service.begin(f.user);
  assert.equal(result.mfaRequired, true); assert.equal(f.state.creates, 1); assert.equal(f.state.mails, 1);
  const exact = fixture([{ ageMs: 3600000, sends: 3 }, { ageMs: 100000, sends: 2 }]);
  await assert.rejects(exact.service.begin(exact.user), { code: 'auth_email_rate_limited', retryAfterSeconds: 1 });
  exact.advance(1); await exact.service.begin(exact.user);
  assert.equal(exact.state.mails, 1);
});

test('temporary resend limits provide timing without sending; exhausted and locked intents provide no false retry', async () => {
  const f = fixture(); f.attach({ last_sent_at: new Date(Date.UTC(2030, 0, 1, 12) - 15200) });
  await assert.rejects(f.service.resend('A'.repeat(43)), { code: 'auth_email_rate_limited', retryAfterSeconds: 45 });
  f.state.rows[0].sends = 3;
  await assert.rejects(f.service.resend('A'.repeat(43)), error => error.code === 'auth_email_rate_limited' && !Object.hasOwn(error, 'retryAfterSeconds'));
  f.state.rows[0].sends = 1; f.state.rows[0].attempts = 5;
  await assert.rejects(f.service.resend('A'.repeat(43)), error => error.code === 'auth_email_locked' && !Object.hasOwn(error, 'retryAfterSeconds'));
  assert.equal(f.state.mails, 0); assert.equal(f.state.creates, 0);
});

function controllerFixture(error) {
  let passwordOk = true, begins = 0;
  const user = { id_usuario: 17, estado_cuenta: 'activo', email_usuario: 'offline@example.invalid', password_usuario: 'FICTITIOUS_HASH' };
  const controller = { exports: {} };
  const deps = { dotenv: { config() {} }, bcryptjs: { compare: async () => passwordOk },
    '../../models': { Usuario: { findOne: async () => user, findByPk: async () => user } },
    '../services/accessSession.service': { activeUser: value => value?.estado_cuenta === 'activo' },
    '../lib/blocked-auth-emails': { isBlockedAuthEmail: () => false },
    '../services/authTrustedDevice.service': { cookie: () => null },
    '../services/authEmailChallenge.service': { mode: () => 'enforce', rejectedCredentials: async () => {},
      begin: async () => { begins++; throw error; }, resend: async () => { throw error; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../controllers/auth.controllers'), 'utf8'), {
    module: controller, exports: controller.exports, console: { error() {} }, require: name => deps[name] || {},
  });
  async function call(method = 'signIn') {
    const res = { headers: {}, set(name, value) { this.headers[name] = value; return this; },
      status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await controller.exports[method]({ body: method === 'resendEmailCode' ? { challengeToken: 'A'.repeat(43) }
      : { email: user.email_usuario, password: 'FICTITIOUS_PASSWORD' }, userData: { userId: user.id_usuario } }, res);
    return res;
  }
  return { call, wrongPassword: () => { passwordOk = false; }, begins: () => begins };
}

test('HTTP 429 exposes the same bounded Retry-After in header and body, with no private exception fields', async () => {
  for (const seconds of [1, 26, 3600]) {
    const f = controllerFixture(Object.assign(Error('private exception'), { code: 'auth_email_rate_limited', retryAfterSeconds: seconds, privateToken: 'NEVER_RETURN' }));
    for (const method of ['signIn', 'resendEmailCode']) {
      const res = await f.call(method);
      assert.equal(res.statusCode, 429); assert.equal(res.headers['Retry-After'], String(seconds));
      assert.equal(res.body.retryAfterSeconds, seconds); assert.equal(res.body.error, 'auth_email_rate_limited');
      assert(!JSON.stringify(res.body).includes('NEVER_RETURN')); assert(!JSON.stringify(res.body).includes('private exception'));
    }
  }
});

test('invalid credentials remain 401 without invoking a code request or returning retry metadata', async () => {
  const f = controllerFixture(Object.assign(Error(), { code: 'auth_email_rate_limited', retryAfterSeconds: 60 }));
  f.wrongPassword(); const res = await f.call();
  assert.equal(res.statusCode, 401); assert.equal(res.body.message, 'Wrong email or password.');
  assert.equal(f.begins(), 0); assert(!Object.hasOwn(res.headers, 'Retry-After')); assert(!Object.hasOwn(res.body, 'retryAfterSeconds'));
});

test('locked, exhausted, malformed or unavailable errors never fabricate a recovery countdown', async () => {
  for (const [code, seconds, status] of [['auth_email_locked', 60, 429], ['auth_email_rate_limited', undefined, 429],
    ['auth_email_rate_limited', 0, 429], ['auth_email_rate_limited', 3601, 429], ['auth_email_rate_limited', Infinity, 429],
    ['auth_email_rate_limited', '60', 429], ['auth_email_expired', 60, 401], ['auth_email_unavailable', 60, 503], ['unknown', 60, 503]]) {
    const res = await controllerFixture(Object.assign(Error(), { code, retryAfterSeconds: seconds })).call();
    assert.equal(res.statusCode, status); assert(!Object.hasOwn(res.headers, 'Retry-After'));
    assert(!Object.hasOwn(res.body, 'retryAfterSeconds'));
  }
});
