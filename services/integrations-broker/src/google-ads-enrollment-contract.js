'use strict';
const { createHash, createPublicKey } = require('node:crypto');
const { schema, ref } = require('./contracts');
const ads = require('./google-ads-contract');
const oauth = require('./google-oauth-contract');
const { fail } = require('./errors');
const PREFIX = 'google.ads.enrollment.';
const OPERATIONS = Object.freeze(Object.fromEntries(['discover', 'prepare', 'activate', 'status'].map(name => [name, PREFIX + name + '.v1'])));
const REVOKE_OPERATION = PREFIX + 'revoke.v1';
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const customer = { type: 'string', pattern: '^[0-9]{10}$' };
const id = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const scopeSchema = object({
  assetRef: { type: 'string', pattern: '^ads-enroll:(clinic|group):[1-9][0-9]{0,9}$' },
  tenantRef: { type: 'string', pattern: '^clinic:[1-9][0-9]{0,9}$' },
  rootCustomerId: customer, loginCustomerId: { ...customer, type: ['string', 'null'] },
  readPrincipalId: ref, controlPrincipalId: ref,
  readOperations: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ads.OPERATIONS } },
  maxAssets: { type: 'integer', minimum: 1, maximum: 1000 },
  managerAccess: { enum: ['exclusive', 'shared'] },
  allowedCustomerIds: { type: 'array', minItems: 1, maxItems: 1000, uniqueItems: true, items: customer },
}, ['assetRef', 'tenantRef', 'rootCustomerId', 'loginCustomerId', 'readPrincipalId', 'controlPrincipalId', 'readOperations', 'maxAssets']);
const identity = { enrollmentId: id, customerId: customer, clinicCount: { type: 'integer', minimum: 1, maximum: 1000 },
  clinicSetDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const validators = {
  discover: schema({ pageToken: { type: ['string', 'null'], maxLength: 4096 } }),
  prepare: schema(identity), activate: schema(identity), revoke: schema(identity), status: schema({ enrollmentId: id }),
};
function scopeFor(binding, assetRef, tenantRef) {
  const scope = binding?.googleAdsEnrollmentScopes?.find(s => s.assetRef === assetRef && s.tenantRef === tenantRef);
  if (!scope || !ads.customer(scope.rootCustomerId) || scope.loginCustomerId !== null && !ads.customer(scope.loginCustomerId)
    || scope.assetRef.startsWith('ads-enroll:clinic:') && scope.assetRef !== 'ads-enroll:' + scope.tenantRef) fail('scope_denied');
  if (scope.managerAccess === 'shared') {
    if (!Array.isArray(scope.allowedCustomerIds) || !scope.allowedCustomerIds.length
      || scope.allowedCustomerIds.length > 1000 || new Set(scope.allowedCustomerIds).size !== scope.allowedCustomerIds.length
      || scope.allowedCustomerIds.some(id => !ads.customer(id) || id === scope.rootCustomerId)) fail('scope_denied');
  } else if (scope.allowedCustomerIds !== undefined || ![undefined, 'exclusive'].includes(scope.managerAccess)) fail('scope_denied');
  return scope;
}
const allowsCustomer = (scope, id) => scope.managerAccess !== 'shared' || scope.allowedCustomerIds.includes(id);
function digestFor(binding, scope) {
  // Public-key rotation and unrelated policy edits do not change ownership. A
  // change to a connection identity, scope or delegated rights must fail closed.
  // Candidate-list changes are checked per customer so that admitting a new
  // candidate cannot interrupt an existing account that is still allowed.
  return createHash('sha256').update(JSON.stringify([binding.connectionRef, binding.googleSubject,
    binding.secretArn, binding.clientSecretArn, binding.developerSecretArn, scope.assetRef, scope.tenantRef,
    scope.rootCustomerId, scope.loginCustomerId, scope.readPrincipalId, scope.controlPrincipalId,
    [...scope.readOperations].sort(), scope.maxAssets])).digest('hex');
}
function ownerFor(policy, binding, scope) {
  const owners = new Set(policy.grants.filter(g => g.connectionRef === binding.connectionRef && g.assetRef === scope.assetRef
    && g.tenantRef === scope.tenantRef && g.operations.some(op => Object.values(OPERATIONS).includes(op))).map(g => g.principalId));
  if (owners.size !== 1) fail('invalid_request'); return [...owners][0];
}
function validatePolicy(policy) {
  const roles = { read: new Set(), control: new Set(), oauth: new Set(), enrollment: new Set() };
  const oauthOps = Object.values(oauth.operationsFor(ads.PROVIDER));
  const providerOps = [...ads.OPERATIONS, ...Object.values(require('./google-data-manager-contract').OPERATIONS),
    ...Object.values(require('./google-action-management-contract').OPERATIONS),
    ...Object.values(require('./google-destination-contract').OPERATIONS)];
  for (const grant of policy.grants) {
    if (grant.operations.some(op => providerOps.includes(op))) roles.read.add(grant.principalId);
    if (grant.operations.some(op => [ads.REVOKE_OPERATION, REVOKE_OPERATION].includes(op))) roles.control.add(grant.principalId);
    if (grant.operations.some(op => oauthOps.includes(op))) roles.oauth.add(grant.principalId);
    if (grant.operations.some(op => Object.values(OPERATIONS).includes(op))) roles.enrollment.add(grant.principalId);
  }
  const managers = new Map(); const allowed = new Set();
  for (const binding of policy.connections) {
    const seen = new Set();
    for (const scope of binding.googleAdsEnrollmentScopes || []) {
      scopeFor(binding, scope.assetRef, scope.tenantRef);
      if (seen.has(scope.assetRef) || !scope.readOperations.includes('google.ads.discovery.read.v1')) fail('invalid_request');
      seen.add(scope.assetRef); roles.read.add(scope.readPrincipalId); roles.control.add(scope.controlPrincipalId);
      const sharesManager = scope.managerAccess === 'shared';
      if (managers.has(scope.rootCustomerId) && !(sharesManager && managers.get(scope.rootCustomerId))) fail('invalid_request');
      managers.set(scope.rootCustomerId, sharesManager);
      for (const customerId of scope.allowedCustomerIds || []) {
        if (allowed.has(customerId)) fail('invalid_request');
        allowed.add(customerId);
      }
      const grants = policy.grants.filter(g => g.connectionRef === binding.connectionRef && g.assetRef === scope.assetRef);
      ownerFor(policy, binding, scope);
      for (const grant of grants) {
        if (grant.tenantRef !== scope.tenantRef || grant.operations.some(op => !Object.values(OPERATIONS).includes(op)
          && !oauthOps.includes(op) && ![ads.REVOKE_OPERATION, REVOKE_OPERATION].includes(op))
          || grant.operations.some(op => [ads.REVOKE_OPERATION, REVOKE_OPERATION].includes(op)) && grant.principalId !== scope.controlPrincipalId) fail('invalid_request');
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
function query(customerId = null, allowedCustomerIds) {
  if (customerId !== null && !ads.customer(customerId)) fail('invalid_request');
  if (allowedCustomerIds !== undefined && (!Array.isArray(allowedCustomerIds) || !allowedCustomerIds.length
    || allowedCustomerIds.length > 1000 || allowedCustomerIds.some(id => !ads.customer(id)))) fail('invalid_request');
  const allowed = allowedCustomerIds ? ` AND customer_client.id IN (${allowedCustomerIds.join(', ')})` : '';
  return 'SELECT customer_client.id, customer_client.client_customer, customer_client.level, customer_client.manager, '
    + 'customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.status '
    + 'FROM customer_client WHERE customer_client.level >= 1 AND customer_client.manager = FALSE'
    + (customerId ? ` AND customer_client.id = ${customerId}` : allowed) + (customerId ? ' LIMIT 2' : ' LIMIT 1001');
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
module.exports = { PREFIX, OPERATIONS, REVOKE_OPERATION, scopeSchema, validators, scopeFor, allowsCustomer, digestFor, ownerFor, validatePolicy, query, project };
