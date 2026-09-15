'use strict';
// Typed gateway transport. No provider credentials, models, AWS or legacy OAuth.
const fs = require('node:fs'); const path = require('node:path'); const { randomUUID } = require('node:crypto');
const S = require('../services/whatsappAuthorizationState.contract');
const C = require('../../services/integrations-broker/src/whatsapp-onboarding-contract');
const { createIntegrationsBrokerClient } = require('./integrationsBrokerClient');
const fail = (code = 'whatsapp_onboarding_broker_unavailable', unknown = false) => {
  throw Object.assign(Error(code), { code, status: 503, httpStatus: 503, outcomeUnknown: unknown });
};
function assertGateway(env = process.env) {
  const config = S.settings(env); config.key.fill(0);
}
function binding(value, row) {
  try {
    S.exact(value, ['connectionRef', 'scopeKey', 'clinicIds', 'appId', 'configId', 'redirectUri', 'scopes',
      ...(Object.hasOwn(value || {}, 'customer') ? ['customer'] : [])]);
    if (typeof value.connectionRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.connectionRef)) throw Error();
    // Reuse the broker's metadata constraints, without putting secret ARNs or
    // their versions in gateway configuration.
    C.bindingFor({ provider: C.PROVIDER, secretArn: 'candidate', clientSecretArn: 'app', whatsappOnboarding: {
      ...Object.fromEntries(['scopeKey', 'clinicIds', 'appId', 'configId', 'redirectUri', 'scopes'].map(k => [k, value[k]])),
      ...(Object.hasOwn(value, 'customer') ? { customer: value.customer } : {}),
      appVersionId: 'a'.repeat(32), slotVersionId: 'b'.repeat(32),
    } });
    if (row && (value.scopeKey !== row.scope.type + ':' + row.scope.id || JSON.stringify(value.clinicIds) !== JSON.stringify(row.clinicIds))) throw Error();
    return structuredClone(value);
  } catch { fail('whatsapp_onboarding_binding_invalid'); }
}
function context(value) {
  try {
    S.exact(value, ['requestId','status','scope','clinicIds','expiresAt','scopeDigest','clinicSetDigest',
      ...(Object.hasOwn(value || {}, 'state') ? ['state'] : []), ...(Object.hasOwn(value || {}, 'mayExchange') ? ['mayExchange'] : [])]);
    S.exact(value.scope, ['type','id']);
  } catch { fail('whatsapp_onboarding_binding_invalid'); }
  if (!value || !S.uuid(value.requestId) || !['awaiting', 'claimed', 'cancelled', 'expired'].includes(value.status)
    || !value.scope || !['clinic', 'group'].includes(value.scope.type) || !S.id(value.scope.id)
    || !Array.isArray(value.clinicIds) || !value.clinicIds.length || value.clinicIds.length > 1000
    || value.clinicIds.some((id, i) => !S.id(id) || i > 0 && id <= value.clinicIds[i - 1])
    || !/^[a-f0-9]{64}$/.test(value.scopeDigest) || value.clinicSetDigest !== C.hash(JSON.stringify(value.clinicIds))
    || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || new Date(value.expiresAt).toISOString() !== value.expiresAt) fail('whatsapp_onboarding_binding_invalid');
  return structuredClone(value);
}
function response(result, name, row, b, requestId, selection) {
  try {
    S.exact(result, ['requestId', 'data', 'replayed']);
    if (result.requestId !== requestId || typeof result.replayed !== 'boolean') throw Error();
    const d = result.data;
    S.exact(d, ['flowId', 'status', 'expiresAt', 'expired', 'scopeKey', 'scopeDigest', 'clinicCount', 'clinicSetDigest',
      'configurationChanged', 'accessBlocked', 'connected', 'candidate', ...(Object.hasOwn(d, 'phoneState') ? ['phoneState'] : []), ...(name === 'begin' ? ['authorization'] : [])]);
    if (d.flowId !== row.requestId || !['awaiting','exchanging','staging','staged','interrupted','aborted'].includes(d.status)
      || d.scopeKey !== b.scopeKey || d.clinicCount !== row.clinicIds.length || d.clinicSetDigest !== row.clinicSetDigest
      || !/^[a-f0-9]{64}$/.test(d.scopeDigest) || !Number.isSafeInteger(d.expiresAt) || d.expiresAt <= 0
      || !['expired', 'configurationChanged', 'accessBlocked'].every(k => typeof d[k] === 'boolean') || d.connected !== false) throw Error();
    const tombstone = d.status === 'aborted';
    // An abort before begin has its own creation time/hash, including when the
    // local authorization has already expired. It can never authorize an exchange.
    if (!tombstone && (d.scopeDigest !== row.scopeDigest || d.expiresAt !== Date.parse(row.expiresAt))) throw Error();
    if (name === 'begin') {
      S.exact(d.authorization, ['appId', 'configId', 'redirectUri']);
      if (d.status !== 'awaiting' || d.configurationChanged || d.accessBlocked || d.expired
        || Object.keys(d.authorization).some(k => d.authorization[k] !== b[k])) throw Error();
    }
    if (name === 'abort' && !tombstone) throw Error();
    if (d.status === 'staged') {
      S.exact(d.candidate, ['versionId', 'appId', 'subjectId', 'wabaId', 'phoneId', 'tokenType', 'scopes', 'expiresAt', 'dataAccessExpiresAt',
        ...(b.customer ? ['businessId','grantedWabaIds'] : [])]);
      const v = d.candidate;
      if (v.versionId !== row.requestId || v.appId !== b.appId || ![v.subjectId, v.wabaId, v.phoneId].every(C.id)
        || !['USER', 'SYSTEM_USER'].includes(v.tokenType) || !Array.isArray(v.scopes)
        || JSON.stringify([...v.scopes].sort()) !== JSON.stringify([...b.scopes].sort())
        || ![v.expiresAt, v.dataAccessExpiresAt].every(t => t === null || Number.isSafeInteger(t) && t > 0)
        || selection && (v.wabaId !== selection.wabaId || selection.phoneId !== null && v.phoneId !== selection.phoneId)) throw Error();
      if (b.customer && (!C.id(v.businessId) || b.customer.businessId && v.businessId !== b.customer.businessId || v.tokenType !== 'SYSTEM_USER'
        || !Array.isArray(v.grantedWabaIds) || !v.grantedWabaIds.length || v.grantedWabaIds.length > 64
        || !v.grantedWabaIds.includes(v.wabaId) || v.grantedWabaIds.some((id, i, all) => !C.id(id)
          || b.customer.wabaIds && !b.customer.wabaIds.includes(id) || i > 0 && id <= all[i - 1]))) throw Error();
    } else if (d.candidate !== null) throw Error();
    if (d.phoneState !== undefined && d.phoneState !== null) {
      const p = d.phoneState;
      S.exact(p, ['phoneId', 'isOnBizApp', 'platformType', 'coexistenceAvailable', 'registrationAttempted', 'observedAt']);
      if (!C.id(p.phoneId) || ![true, false, null].includes(p.isOnBizApp)
        || ![null, 'CLOUD_API', 'ON_PREMISE', 'NOT_APPLICABLE'].includes(p.platformType)
        || p.coexistenceAvailable !== (p.isOnBizApp === true && p.platformType === 'CLOUD_API')
        || p.registrationAttempted !== false || !Number.isSafeInteger(p.observedAt) || p.observedAt <= 0
        || d.candidate && d.candidate.phoneId !== p.phoneId) throw Error();
    }
    return { ...structuredClone(d), phoneState: d.phoneState ?? null };
  } catch { fail('whatsapp_onboarding_result_unknown', true); }
}
function createWhatsappOnboardingBrokerClient({ client, loadBinding, guard = assertGateway }) {
  if (typeof client?.execute !== 'function' || typeof loadBinding !== 'function') fail('whatsapp_onboarding_configuration_invalid');
  async function call(name, value, input = {}) {
    guard(); const row = context(value); const payload = structuredClone(input); let selected;
    try { selected = binding(await loadBinding(row.scope), row); } catch { fail('whatsapp_onboarding_binding_invalid'); }
    guard();
    const body = name === 'begin' ? { state: row.state, expiresAt: Date.parse(row.expiresAt), scopeDigest: row.scopeDigest, clinicSetDigest: row.clinicSetDigest }
      : { flowId: row.requestId, ...payload };
    try { C.validators[name](body); } catch { fail('whatsapp_onboarding_binding_invalid'); }
    const requestId = name === 'begin' ? row.requestId : randomUUID();
    try {
      const result = await client.execute({ requestId, tenantRef: 'clinic:' + row.clinicIds[0], assetRef: 'wa-enroll:' + selected.scopeKey,
        connectionRef: selected.connectionRef, operation: C.OPERATIONS[name], payload: body }, { timeoutMs: name === 'status' && payload.readOnly === true ? 5000 : 30000 });
      guard(); const latest = binding(await loadBinding(row.scope), row);
      if (JSON.stringify(latest) !== JSON.stringify(selected)) throw Error();
      return response(result, name, row, selected, requestId, name === 'finish' ? payload : null);
    } catch (error) {
      // Only begin can report a definite, retryable refusal. A finish error
      // never proves that its one-use provider code was not consumed.
      if (name === 'begin' && error?.code === 'oauth_flow_busy') fail('whatsapp_authorization_busy');
      if (name === 'begin' && error?.code === 'rate_limited') fail('whatsapp_authorization_limit');
      fail('whatsapp_onboarding_result_unknown', true);
    }
  }
  return Object.freeze({ begin: row => call('begin', row), finish: (row, input) => call('finish', row, input),
    status: row => call('status', row), statusReadOnly: row => call('status', row, { readOnly: true }),
    abort: row => call('abort', row) });
}
function privateFile(filename, max) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) throw Error();
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > max) throw Error();
  return fs.readFileSync(filename);
}
function configuration(env) {
  let raw;
  try {
    raw = privateFile(env.WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE, 131072); const v = JSON.parse(raw.toString('utf8'));
    S.exact(v, ['version','origin','audience','keyId','privateKeyFile','caFile','bindings']);
    if (v.version !== 1 || !Array.isArray(v.bindings) || !v.bindings.length || v.bindings.length > 64) throw Error();
    v.bindings = v.bindings.map(b => binding(b));
    if (new Set(v.bindings.map(b => b.scopeKey)).size !== v.bindings.length
      || new Set(v.bindings.map(b => b.connectionRef)).size !== v.bindings.length) throw Error();
    return v;
  } catch { fail('whatsapp_onboarding_configuration_invalid'); } finally { raw?.fill(0); }
}
function configuredClient({ environment = () => process.env } = {}) {
  async function execute(name, row, input) {
    assertGateway(environment()); const cfg = configuration(environment()); let key; let ca;
    try {
      key = privateFile(cfg.privateKeyFile, 8192); ca = privateFile(cfg.caFile, 65536);
      const client = createIntegrationsBrokerClient({ origin: cfg.origin, keyId: cfg.keyId, audience: cfg.audience, privateKey: key, ca, timeoutMs: 30000 });
      const api = createWhatsappOnboardingBrokerClient({ client, guard: () => assertGateway(environment()), loadBinding: async scope => {
        const current = configuration(environment());
        if (JSON.stringify(current) !== JSON.stringify(cfg)) fail('whatsapp_onboarding_binding_invalid');
        return current.bindings.find(b => b.scopeKey === scope.type + ':' + scope.id);
      } });
      return await api[name](row, input);
    } catch (error) {
      if (['whatsapp_onboarding_result_unknown','whatsapp_onboarding_binding_invalid',
        'whatsapp_authorization_busy','whatsapp_authorization_limit'].includes(error?.code)) throw error;
      fail('whatsapp_onboarding_configuration_invalid');
    } finally { key?.fill(0); ca?.fill(0); }
  }
  return Object.freeze(Object.fromEntries(['begin','finish','status','statusReadOnly','abort'].map(name => [name, (row, input) => execute(name, row, input)])));
}
module.exports = { createWhatsappOnboardingBrokerClient, configuredClient, assertGateway, configuration };
