'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const contract = require('../../services/metaMarketingOAuth.contract');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');

// Execute the production authorize() body with closed dependencies. Neither
// application models nor session storage, providers or real configuration load.
function fixture({ sessionError, allowed = true } = {}) {
  const state = { sessionChecks: 0, clinicReads: 0, aclChecks: 0, logs: [] };
  const transaction = { LOCK: { UPDATE: 'OFFLINE_UPDATE' } };
  const actor = { scopeKey: 'clinic:71', actorId: 501,
    sessionRef: '00000000-0000-4000-8000-000000000001', sessionExpiresAt: new Date('2030-01-01T00:00:00Z') };
  const models = {
    Clinica: { findAll: async options => {
      state.clinicReads++;
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, transaction.LOCK.UPDATE);
      assert.equal(options.logging, false);
      assert.equal(options.raw, true);
      assert.equal(options.where.id_clinica, 71);
      return [{ id_clinica: 71 }];
    } },
    UsuarioClinica: { findAll: () => { throw Error('UNEXPECTED_MEMBERSHIP_READ'); } },
  };
  const { createScope } = loadDiscoverySource('services/metaMarketingOAuthScope.service.js', {
    './metaMarketingOAuth.contract': contract,
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async input => {
      state.aclChecks++;
      assert.equal(input.userId, actor.actorId);
      assert.deepEqual(Array.from(input.clinicIds), [71]);
      assert.equal(input.access, 'write');
      assert.equal(typeof input.membershipModel.findAll, 'function');
      return allowed;
    } },
  }, { logs: state.logs });
  const scope = createScope({ models, recoveryGuard: {}, sessions: { verifyReference: async (reference, options) => {
    state.sessionChecks++;
    assert.equal(reference.userId, actor.actorId);
    assert.equal(reference.sessionRef, actor.sessionRef);
    assert.equal(reference.expiresAt, actor.sessionExpiresAt);
    assert.equal(options.transaction, transaction);
    assert.equal(options.requireEmail, true);
    if (sessionError !== undefined) throw sessionError;
    return { userId: actor.actorId, sessionRef: actor.sessionRef };
  } } });
  return { actor, transaction, state, authorize: () => scope.authorize(actor, transaction) };
}

async function denied(f, code, httpStatus, { clinicReads = 0, aclChecks = 0 } = {}) {
  await assert.rejects(f.authorize, error => {
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, httpStatus);
    assert.equal(error.message, code);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'httpStatus']);
    assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes('PRIVATE_'), false);
    return true;
  });
  assert.equal(f.state.sessionChecks, 1);
  assert.equal(f.state.clinicReads, clinicReads);
  assert.equal(f.state.aclChecks, aclChecks);
  assert.deepEqual(f.state.logs, []);
}

test('a verified email session still requires the locked clinic write ACL before returning authority', async () => {
  const f = fixture();
  const authorized = await f.authorize();
  assert.equal(authorized.scopeKey, f.actor.scopeKey);
  assert.equal(authorized.actorId, f.actor.actorId);
  assert.equal(authorized.sessionRef, f.actor.sessionRef);
  assert.equal(authorized.sessionExpiresAt, f.actor.sessionExpiresAt);
  assert.deepEqual(Array.from(authorized.clinicIds), [71]);
  assert.equal(authorized.options.transaction, f.transaction);
  assert.deepEqual({ sessionChecks: f.state.sessionChecks, clinicReads: f.state.clinicReads, aclChecks: f.state.aclChecks },
    { sessionChecks: 1, clinicReads: 1, aclChecks: 1 });
});

test('email MFA step-up remains 403 even when a caller supplies an old 401 status', async t => {
  for (const status of [403, 401, undefined]) {
    await t.test(String(status), async () => {
      const error = Object.assign(Error('PRIVATE_MFA_DETAIL'), { code: 'auth_email_verification_required', status });
      await denied(fixture({ sessionError: error }), 'auth_email_verification_required', 403);
    });
  }
});

test('real JWT invalid, expiry, not-before and revoked-session failures remain safe 401', async t => {
  const cases = [
    ['invalid JWT', new jwt.JsonWebTokenError('PRIVATE_JWT_DETAIL')],
    ['expired JWT', new jwt.TokenExpiredError('PRIVATE_EXPIRY_DETAIL', new Date('2026-01-01T00:00:00Z'))],
    ['not-before JWT', new jwt.NotBeforeError('PRIVATE_NBF_DETAIL', new Date('2030-01-01T00:00:00Z'))],
    ['revoked reference', Object.assign(Error('PRIVATE_REVOKED_DETAIL'), { code: 'auth_invalid', status: 401, name: 'JsonWebTokenError' })],
    ['auth_invalid code alone', Object.assign(Error('PRIVATE_INVALID_DETAIL'), { code: 'auth_invalid' })],
  ];
  for (const [label, sessionError] of cases) {
    await t.test(label, () => denied(fixture({ sessionError }), 'meta_oauth_session_required', 401));
  }
});

test('SQL, acquisition timeout, audit and unclassified failures deny authority with safe 503', async t => {
  const cases = [
    ['SQL', { name: 'SequelizeDatabaseError', code: 'ER_QUERY_TIMEOUT', sql: 'PRIVATE_SQL' }],
    ['connection acquisition', { name: 'SequelizeConnectionAcquireTimeoutError' }],
    ['connection failure', { name: 'SequelizeConnectionError', code: 'ECONNRESET' }],
    ['timeout', { name: 'TimeoutError', code: 'ETIMEDOUT' }],
    ['audit failure', { name: 'AuditUnavailable', code: 'audit_unavailable', httpStatus: 503 }],
    ['session storage unavailable', { code: 'auth_session_unavailable', status: 503 }],
    ['unclassified 401', { status: 401 }],
    ['unclassified failure', {}],
  ];
  for (const [label, shape] of cases) {
    await t.test(label, async () => {
      const sessionError = Object.assign(Error('PRIVATE_STORAGE_OR_AUDIT_DETAIL'), shape, { parent: { message: 'PRIVATE_PARENT' } });
      await denied(fixture({ sessionError }), 'meta_oauth_unavailable', 503);
    });
  }
  await t.test('null thrown value', () => denied(fixture({ sessionError: null }), 'meta_oauth_unavailable', 503));
});

test('403 session policy failures retain denial without exposing their private code or message', async t => {
  for (const shape of [{ status: 403 }, { httpStatus: 403 }]) {
    await t.test(Object.keys(shape)[0], () => denied(fixture({
      sessionError: Object.assign(Error('PRIVATE_ACL_DETAIL'), shape, { code: 'PRIVATE_INTERNAL_ACL_CODE' }),
    }), 'meta_oauth_scope_forbidden', 403));
  }
});

test('a valid session cannot bypass a denied clinic write ACL', async () => {
  await denied(fixture({ allowed: false }), 'meta_oauth_scope_forbidden', 403, { clinicReads: 1, aclChecks: 1 });
});
