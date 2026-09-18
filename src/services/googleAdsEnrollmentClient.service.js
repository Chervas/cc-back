'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { randomUUID } = require('node:crypto');
const C = require('./googleAdsEnrollment.contract');
const { createIntegrationsBrokerClient } = require('../lib/integrationsBrokerClient');
const SAFE = new Set(['invalid_request', 'invalid_signature', 'scope_denied', 'operation_denied', 'connection_blocked', 'asset_revoked',
  'idempotency_conflict', 'outcome_unknown', 'rate_limited', 'provider_disabled', 'provider_failed', 'provider_timeout',
  'provider_unauthorized', 'credential_revoked', 'secret_unavailable', 'audit_unavailable', 'broker_timeout', 'broker_unavailable',
  'broker_response_invalid', 'google_ads_enrollment_disabled', 'google_ads_enrollment_invalid', 'google_ads_enrollment_scope_unconfigured',
  'google_ads_enrollment_scope_conflict', 'google_ads_enrollment_lease_lost', 'google_ads_enrollment_worker_disabled',
  'google_discovery_scope_forbidden', 'google_discovery_session_required']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_ads_enrollment_unavailable';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
function createGoogleAdsEnrollmentClient({ client, controlClient, scope, now = Date.now }) {
  const guarded = fn => async (...args) => { try { return await fn(...args); } catch (error) { C.fail(safe(error)); } };
  async function assert(row, context, originalActor) {
    const saved = await scope.assert(context);
    if (saved.scope_key !== row.scope_key || saved.scopeDigest !== row.scope_digest || saved.clinicDigest !== row.clinic_digest
      || saved.google_connection_id !== Number(row.google_connection_id) || saved.google_user_id !== row.google_user_id
      || saved.connection_ref !== row.connection_ref || saved.asset_ref !== row.scope_ref || saved.tenant_clinic_id !== Number(row.tenant_clinic_id)
      || (saved.login_customer_id || saved.root_customer_id) !== row.login_customer_id
      || originalActor && (saved.actorId !== Number(row.actor_user_id) || saved.sessionRef !== row.session_ref
        || saved.sessionExpiresAt !== row.session_expires_at.getTime())) C.fail('google_ads_enrollment_scope_conflict');
    return saved;
  }
  async function send(row, name, context, options = {}) {
    row = structuredClone(C.request(row));
    const revoke = name === 'revoke'; const status = name === 'status';
    const states = name === 'prepare' ? ['prepare_pending', 'prepared'] : name === 'activate' ? ['activate_pending', 'activation_confirmed', 'active']
      : revoke ? ['revoke_pending', 'revoked'] : C.STATES;
    if (!states.includes(row.state)) C.fail('google_ads_enrollment_scope_conflict');
    if (!revoke) await assert(row, context, !status);
    // The control caller supplies a durable-intent check. It remains independent
    // from a user session that may have expired while the request was in flight.
    if (revoke && typeof options.beforeExecute !== 'function') C.fail();
    if (revoke) { if (await options.beforeExecute() !== true) C.fail('google_ads_enrollment_scope_conflict'); }
    else { await options.beforeExecute?.(); await assert(row, context, !status); }
    const requestId = status ? randomUUID() : row[name + '_request_id'];
    const result = await (revoke ? controlClient : client).execute({ requestId,
      operation: revoke ? C.broker.REVOKE_OPERATION : C.broker.OPERATIONS[name],
      tenantRef: 'clinic:' + row.tenant_clinic_id, connectionRef: row.connection_ref, assetRef: row.scope_ref,
      payload: status ? { enrollmentId: row.enrollment_id } : C.payload(row) }, { timeoutMs: 10000 });
    if (!revoke) await assert(row, context, !status);
    const fields = ['enrollmentId', 'assetRef', 'scopeRef', 'clinicCount', 'clinicSetDigest', 'state', ...((revoke || status) ? ['accessBlocked'] : [])];
    if (!exact(result, ['requestId', 'data', 'replayed']) || result.requestId !== requestId || typeof result.replayed !== 'boolean'
      || !exact(result.data, fields) || result.data.enrollmentId !== row.enrollment_id || result.data.assetRef !== 'ads:' + row.customer_id
      || result.data.scopeRef !== row.scope_ref || result.data.clinicCount !== Number(row.clinic_count)
      || result.data.clinicSetDigest !== row.clinic_digest
      || !(revoke ? ['revoked'] : status ? ['prepared', 'active', 'revoked'] : name === 'activate' ? ['active'] : ['prepared', 'active']).includes(result.data.state)
      || (revoke || status) && typeof result.data.accessBlocked !== 'boolean' || revoke && result.data.accessBlocked !== true) C.fail('broker_response_invalid');
    return structuredClone(result.data);
  }
  return {
    prepare: guarded((row, context, options) => send(row, 'prepare', context, options)),
    activate: guarded((row, context, options) => send(row, 'activate', context, options)),
    status: guarded((row, context, options) => send(row, 'status', context, options)),
    revoke: guarded((row, options) => send(row, 'revoke', null, options)),
    discover: guarded(async context => {
      const deadline = now() + 60000; let pageToken = null; const seen = new Set(); const ids = new Set(); const accounts = [];
      for (let page = 0; page < 4; page++) {
        const captured = await scope.assert(context); if (now() >= deadline) C.fail('provider_timeout');
        const requestId = randomUUID();
        const result = await client.execute({ requestId, operation: C.broker.OPERATIONS.discover,
          tenantRef: 'clinic:' + captured.tenant_clinic_id, connectionRef: captured.connection_ref, assetRef: captured.asset_ref,
          payload: { pageToken } }, { timeoutMs: Math.min(10000, deadline - now()) });
        await scope.assert(context); if (now() >= deadline) C.fail('provider_timeout');
        if (!exact(result, ['requestId', 'data', 'replayed']) || result.requestId !== requestId || result.replayed !== false
          || !exact(result.data, ['accounts', 'nextPageToken']) || !Array.isArray(result.data.accounts) || result.data.accounts.length > 250
          || Buffer.byteLength(JSON.stringify(result.data)) > 786432) C.fail('broker_response_invalid');
        for (const account of result.data.accounts) {
          if (!exact(account, ['id', 'manager', 'currencyCode', 'timeZone', 'descriptiveName', 'status']) || C.customer(account.id) !== account.id
            || ids.has(account.id) || account.manager !== false || !/^[A-Z]{3}$/.test(account.currencyCode || '')
            || typeof account.descriptiveName !== 'string' || Buffer.byteLength(account.descriptiveName) > 1024
            || /[\x00-\x1f]/.test(account.descriptiveName) || typeof account.timeZone !== 'string' || account.timeZone.length > 128
            || !['ENABLED', 'SUSPENDED', 'UNKNOWN', 'UNSPECIFIED'].includes(account.status)) C.fail('broker_response_invalid');
          try { new Intl.DateTimeFormat('en-US', { timeZone: account.timeZone }).format(); } catch { C.fail('broker_response_invalid'); }
          ids.add(account.id); accounts.push({ customerId: account.id, descriptiveName: account.descriptiveName, currencyCode: account.currencyCode,
            timeZone: account.timeZone, accountStatus: account.status, isManager: false,
            formattedCustomerId: `${account.id.slice(0,3)}-${account.id.slice(3,6)}-${account.id.slice(6)}`,
            loginCustomerId: captured.login_customer_id || captured.root_customer_id });
        }
        const next = result.data.nextPageToken;
        if (next === null) return { accounts, unavailableAccountCount: 0 };
        if (typeof next !== 'string' || !/^[A-Za-z0-9_-]{40,4096}$/.test(next) || seen.has(next)) C.fail('broker_response_invalid');
        seen.add(next); pageToken = next;
      }
      C.fail('broker_response_invalid');
    }),
  };
}
function privateFile(filename) {
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) C.fail();
    const stat = fs.statSync(filename); if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536) C.fail();
    return fs.readFileSync(filename);
  } catch { C.fail('google_ads_enrollment_unavailable'); }
}
function configuredClients() {
  let enrollment; let control;
  const make = role => createIntegrationsBrokerClient({ origin: process.env.GOOGLE_ADS_BROKER_ORIGIN,
    audience: process.env.GOOGLE_ADS_BROKER_AUDIENCE, ca: privateFile(process.env.GOOGLE_ADS_BROKER_CA_FILE),
    keyId: process.env['GOOGLE_ADS_BROKER_' + role + '_KEY_ID'], privateKey: privateFile(process.env['GOOGLE_ADS_BROKER_' + role + '_KEY_FILE']), timeoutMs: 10000 });
  return { client: { execute(...args) { return (enrollment ||= make('ENROLLMENT')).execute(...args); } },
    controlClient: { execute(...args) { return (control ||= make('CONTROL')).execute(...args); } } };
}
module.exports = { createGoogleAdsEnrollmentClient, configuredClients, safe };
