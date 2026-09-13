'use strict';
const { createHash, createPublicKey } = require('node:crypto');
const { schema, ref } = require('./contracts');
const ads = require('./google-ads-contract');
const oauth = require('./google-oauth-contract');
const { fail } = require('./errors');
const PREFIX = 'google.ads.enrollment.';
const OPERATIONS = Object.freeze(Object.fromEntries(['discover', 'prepare', 'activate', 'status'].map(name => [name, PREFIX + name + '.v1'])));
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const customer = { type: 'string', pattern: '^[0-9]{10}$' };
const id = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const scopeSchema = object({
  assetRef: { type: 'string', pattern: '^ads-enroll:(clinic|group):[1-9][0-9]{0,9}$' },
  tenantRef: { type: 'string', pattern: '^clinic:[1-9][0-9]{0,9}$' },
  rootCustomerId: customer, loginCustomerId: { ...customer, type: ['string', 'null'] },
  readPrincipalId: ref, controlPrincipalId: ref,
  readOperations: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ads.OPERATIONS } },
  maxAssets: { type: 'integer', minimum: 1, maximum: 1000 },
});
const identity = { enrollmentId: id, customerId: customer, clinicCount: { type: 'integer', minimum: 1, maximum: 1000 },
  clinicSetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const validators = {
  discover: schema({ pageToken: { type: ['string', 'null'], maxLength: 4096 } }),
  prepare: schema(identity), activate: schema(identity), status: schema({ enrollmentId: id }),
};
function scopeFor(binding, assetRef, tenantRef) {
  const scope = binding?.googleAdsEnrollmentScopes?.find(s => s.assetRef === assetRef && s.tenantRef === tenantRef);
  if (!scope || !ads.customer(scope.rootCustomerId) || scope.loginCustomerId !== null && !ads.customer(scope.loginCustomerId)
    || scope.assetRef.startsWith('ads-enroll:clinic:') && scope.assetRef !== 'ads-enroll:' + scope.tenantRef) fail('scope_denied');
  return scope;
}
function digestFor(binding, scope) {
  // Public-key rotation and unrelated policy edits do not change ownership. A
  // change to a connection identity, scope or delegated rights must fail closed.
  return createHash('sha256').update(JSON.stringify([binding.connectionRef, binding.googleSubject,
    binding.secretArn, binding.clientSecretArn, binding.developerSecretArn, scope.assetRef, scope.tenantRef,
    scope.rootCustomerId, scope.loginCustomerId, scope.readPrincipalId, scope.controlPrincipalId,
    [...scope.readOperations].sort(), scope.maxAssets])).digest('hex');
}
function validatePolicy(policy) {
  const roles = { read: new Set(), control: new Set(), oauth: new Set(), enrollment: new Set() };
  const oauthOps = Object.values(oauth.operationsFor(ads.PROVIDER));
  for (const grant of policy.grants) {
    if (grant.operations.some(op => ads.OPERATIONS.includes(op))) roles.read.add(grant.principalId);
    if (grant.operations.includes(ads.REVOKE_OPERATION)) roles.control.add(grant.principalId);
    if (grant.operations.some(op => oauthOps.includes(op))) roles.oauth.add(grant.principalId);
    if (grant.operations.some(op => Object.values(OPERATIONS).includes(op))) roles.enrollment.add(grant.principalId);
  }
  for (const binding of policy.connections) {
    const seen = new Set();
    for (const scope of binding.googleAdsEnrollmentScopes || []) {
      scopeFor(binding, scope.assetRef, scope.tenantRef);
      if (seen.has(scope.assetRef) || !scope.readOperations.includes('google.ads.discovery.read.v1')) fail('invalid_request');
      seen.add(scope.assetRef); roles.read.add(scope.readPrincipalId); roles.control.add(scope.controlPrincipalId);
      const grants = policy.grants.filter(g => g.connectionRef === binding.connectionRef && g.assetRef === scope.assetRef);
      if (!grants.some(g => g.operations.some(op => Object.values(OPERATIONS).includes(op)))) fail('invalid_request');
      for (const grant of grants) {
        if (grant.tenantRef !== scope.tenantRef || grant.operations.some(op => !Object.values(OPERATIONS).includes(op)
          && !oauthOps.includes(op) && op !== ads.REVOKE_OPERATION)
          || grant.operations.includes(ads.REVOKE_OPERATION) && grant.principalId !== scope.controlPrincipalId) fail('invalid_request');
      }
    }
  }
  const key = id => {
    const principal = policy.principals.find(p => p.id === id); if (!principal) fail('invalid_request');
    try { return createPublicKey(principal.publicKey).export({ format: 'der', type: 'spki' }).toString('base64'); }
    catch { fail('invalid_request'); }
  };
  const keys = Object.values(roles).map(ids => new Set([...ids].map(key)));
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    if ([...keys[i]].some(k => keys[j].has(k))) fail('invalid_request');
  }
}
function query(customerId = null) {
  if (customerId !== null && !ads.customer(customerId)) fail('invalid_request');
  return 'SELECT customer_client.id, customer_client.client_customer, customer_client.level, customer_client.manager, '
    + 'customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status '
    + 'FROM customer_client WHERE customer_client.level >= 1 AND customer_client.manager = FALSE'
    + (customerId ? ` AND customer_client.id = ${customerId}` : '') + (customerId ? ' LIMIT 2' : ' LIMIT 1001');
}
function project(raw, selected = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.error || raw.errors || raw.partialFailureError
    || raw.partial_failure_error || raw.nextPageToken || raw.results !== undefined && !Array.isArray(raw.results)) fail('provider_failed');
  const rows = raw.results || []; const seen = new Set();
  if (rows.length > (selected ? 1 : 1000) || selected && rows.length !== 1) fail('provider_failed');
  return rows.map(row => {
    const c = row?.customerClient;
    if (!c || !ads.customer(c.id) || seen.has(c.id) || c.clientCustomer !== 'customers/' + c.id
      || !/^[1-9][0-9]{0,4}$/.test(String(c.level)) || Number(c.level) > 10000
      || c.manager !== undefined && c.manager !== false || selected && c.id !== selected) fail('provider_failed');
    seen.add(c.id);
    // Reuse the closed account summary projection and its byte/status/timezone checks.
    const page = ads.projectPage('discovery', { results: [{ customer: { id: c.id, manager: false,
      descriptiveName: c.descriptiveName, currencyCode: c.currencyCode, timeZone: c.timeZone, status: c.status } }] }, {}, { customerId: c.id });
    return page.results[0].customer;
  }).filter(c => !['CLOSED', 'CANCELED'].includes(c.status));
}
module.exports = { PREFIX, OPERATIONS, scopeSchema, validators, scopeFor, digestFor, validatePolicy, query, project };
