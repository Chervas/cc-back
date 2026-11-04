'use strict';

require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const sourceReads = require('../../lib/searchConsoleReadSource');
const { prepareValidatedReportSnapshot } = require('../../lib/validated-report-snapshot');

// The real controller, scope fences and snapshot coordinator run with closed
// dependencies. No application bootstrap, database or provider is contacted.
function fixture() {
  const f = { sessionChecks: 0, scopeChecks: 0, reads: 0, logs: [], session: { userId: 501, jti: 'offline-session', sessionVersion: 1 } };
  const site = 'https://group.example.invalid/';
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    sequelize,
    '../../models': { Sequelize: sequelize },
    '../lib/searchConsoleReadSource': sourceReads,
    '../lib/validated-report-snapshot': { prepareValidatedReportSnapshot },
    '../lib/clinicScope': { resolveClinicScope: async raw => {
      assert.equal(raw, 'group:9');
      return { isValid: true, isAll: false, scope: 'group', groupId: 9, clinicIds: [71, 72], original: raw };
    } },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async input => {
      assert.equal(input.userId, 501);
      assert.deepEqual(Array.from(input.clinicIds), [71, 72]);
      assert.equal(input.access, 'read');
      return ++f.scopeChecks !== f.deniedScopeCheck;
    } },
    '../lib/role-helpers': { isGlobalAdmin: () => false },
    '../services/effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: async input => {
      assert.equal(input.groupIdRaw, 9);
      assert.equal(input.assignmentScopeRaw, 'group');
      assert.equal(input.clinicIdRaw, null);
      return { scope: { clinic_ids: [71, 72] }, google: { available_assets: { search_console: [
        { mapping_id: 1, clinic_id: 71, connection_id: 81, site_url: f.site || site },
      ] } } };
    } },
    '../services/searchConsoleBroker.service': { prepare: async () => { if (f.revoked) throw Error('offline-revoked'); } },
    '../services/searchConsoleAnalytics.service': { readRevisions: async () => [{ siteUrl: site, revision: '1' }] },
    '../services/accessSession.service': { bearer: value => {
      assert.equal(value, 'OFFLINE_ONLY'); return value;
    }, verify: async () => {
      if (++f.sessionChecks === f.failedSessionCheck) throw f.sessionError;
      return f.session;
    } },
    '../services/marketingReportOverviewCache.service': {
      buildOverviewCacheIdentity: ({ contextKey }) => ({ cache_key: contextKey }),
      overviewCache: { readOrGenerate: async () => {
        f.reads++; await f.afterRead?.();
        return { success: true, marker: 'PRIVATE_CACHED_REPORT' };
      } },
    },
  }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' }, logs: f.logs });
  f.request = async () => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller.getOverview({ query: { clinicId: 'group:9', startDate: '2026-10-01', endDate: '2026-10-30' },
      userData: { userId: 501 }, headers: { authorization: 'OFFLINE_ONLY' } }, res);
    return res;
  };
  return f;
}

function denied(response, status, code) {
  assert.equal(response.statusCode, status);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error, code);
  assert.equal(response.body.marker, undefined);
  assert.equal(JSON.stringify(response.body).includes('PRIVATE_'), false);
}

test('group overview validates the same managed session and complete clinic scope before and after snapshot I/O', async () => {
  const f = fixture(); const response = await f.request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.marker, 'PRIVATE_CACHED_REPORT');
  assert.equal(f.sessionChecks, 2);
  assert.equal(f.scopeChecks, 3);
  assert.equal(f.reads, 1);
});

test('transient SQL, timeout and audit errors at either session fence return safe 503 without disclosing a snapshot', async () => {
  for (const phase of [1, 2]) {
    for (const name of ['SequelizeConnectionAcquireTimeoutError', 'SequelizeConnectionError', 'TimeoutError', 'AuditUnavailable']) {
      const f = fixture(); f.failedSessionCheck = phase;
      f.sessionError = Object.assign(Error('PRIVATE_SQL_OR_AUDIT_DETAIL'), { name, code: 'PRIVATE_INTERNAL_CODE' });
      const response = await f.request();
      denied(response, 503, 'search_console_session_unavailable');
      assert.equal(f.sessionChecks, phase);
      assert.equal(f.reads, phase - 1);
      const logged = f.logs.flat().map(value => String(value?.stack || value?.message || JSON.stringify(value))).join('\n');
      assert.equal(logged.includes('PRIVATE_'), false);
    }
  }
});

test('invalid, expired, not-yet-valid and revoked sessions still return 401 at either session fence', async () => {
  for (const phase of [1, 2]) {
    for (const shape of [{ name: 'JsonWebTokenError' }, { name: 'TokenExpiredError' }, { name: 'NotBeforeError' }, { code: 'auth_invalid' }]) {
      const f = fixture(); f.failedSessionCheck = phase;
      f.sessionError = Object.assign(Error('PRIVATE_SESSION_DETAIL'), shape);
      denied(await f.request(), 401, 'search_console_session_required');
      assert.equal(f.reads, phase - 1);
    }
    const f = fixture();
    if (phase === 1) f.session = null;
    else f.afterRead = () => { f.session = null; };
    denied(await f.request(), 401, 'search_console_session_required');
  }
});

test('legacy, mismatched and unmanaged sessions cannot become fallback report authority', async () => {
  for (const session of [{ userId: 501 }, { userId: 501, jti: 'offline-session' },
    { userId: 502, jti: 'offline-session', sessionVersion: 1 }, { userId: 501, sessionVersion: 1 }]) {
    const f = fixture(); f.session = session;
    denied(await f.request(), 401, 'search_console_session_required');
    assert.equal(f.reads, 0);
  }
});

test('real 403 session denials remain denied and do not disclose a snapshot', async () => {
  for (const phase of [1, 2]) {
    for (const shape of [{ status: 403 }, { httpStatus: 403 }]) {
      const f = fixture(); f.failedSessionCheck = phase;
      f.sessionError = Object.assign(Error('PRIVATE_ACCESS_DETAIL'), shape);
      denied(await f.request(), 403, 'search_console_scope_forbidden');
      assert.equal(f.reads, phase - 1);
    }
  }
});

test('group ACL, binding revocation and source-change fences remain effective around snapshot I/O', async () => {
  for (const check of [1, 2, 3]) {
    const f = fixture(); f.deniedScopeCheck = check;
    const response = await f.request();
    denied(response, 403, check === 1 ? 'scope_forbidden' : 'search_console_scope_forbidden');
    assert.equal(f.reads, check === 3 ? 1 : 0);
  }
  for (const phase of ['before', 'after']) {
    const f = fixture();
    if (phase === 'before') f.revoked = true;
    else f.afterRead = () => { f.revoked = true; };
    denied(await f.request(), 403, 'search_console_scope_forbidden');
    assert.equal(f.reads, phase === 'before' ? 0 : 1);
  }
  const f = fixture(); f.afterRead = () => { f.site = 'https://changed.example.invalid/'; };
  denied(await f.request(), 409, 'sc_analytics_configuration_changed');
});
