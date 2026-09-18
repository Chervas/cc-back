'use strict';
const { schema, ref } = require('./contracts');
const A = require('./google-action-management-contract');
const { fail } = require('./errors');
const OPERATIONS = Object.freeze(Object.fromEntries(['authorize', 'status', 'revoke']
  .map(name => [name, 'google.ads.conversion_destinations.' + name + '.v1'])));
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const events = { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { enum: A.EVENTS } };
const sources = { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ['WEB', 'OTHER'] } };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const bindingSchema = object({ accounts: { type: 'array', minItems: 1, maxItems: 1000,
  items: object({ assetRef: ref, events, sources }) } });
const authorizationInput = { planId: uuid,
  targets: { type: 'array', minItems: 1, maxItems: 5, items: object({ event: { enum: A.EVENTS }, sources }) } };
const revokeWithInput = schema({ authorizationId: uuid, input: object(authorizationInput) });
const validators = { [OPERATIONS.authorize]: schema(authorizationInput),
  [OPERATIONS.status]: schema({ authorizationId: uuid }), [OPERATIONS.revoke]: schema({ authorizationId: uuid }) };
function validate(operation, payload) {
  if (!Object.hasOwn(validators, operation)) fail('operation_denied');
  if (operation === OPERATIONS.revoke && Object.hasOwn(payload || {}, 'input')) {
    revokeWithInput(payload); validate(OPERATIONS.authorize, payload.input);
  } else validators[operation](payload);
  if (operation === OPERATIONS.authorize && new Set(payload.targets.map(row => row.event)).size !== payload.targets.length) fail('invalid_request');
  return payload;
}
const validateShape = schema({ value: bindingSchema });
function validateBinding(binding) {
  validateShape({ value: binding.googleDataManagerEnrollment });
  if (!binding.googleDataManager || binding.provider !== 'google_ads') fail('invalid_request');
  const seen = new Set();
  for (const row of binding.googleDataManagerEnrollment.accounts) {
    const policy = binding.googleAdsActionManagement?.accounts.find(item => item.assetRef === row.assetRef);
    if (!policy || seen.has(row.assetRef) || row.events.some(event => !policy.events.includes(event))) fail('invalid_request');
    seen.add(row.assetRef);
  }
}
function resource(binding, assetRef, targets) {
  const account = require('./google-ads-contract').resource(binding, assetRef);
  const policy = binding.googleDataManagerEnrollment?.accounts.find(row => row.assetRef === assetRef);
  if (!policy || targets.some(row => !policy.events.includes(row.event) || row.sources.some(source => !policy.sources.includes(source)))) fail('scope_denied');
  return { ...account, policy, quotaProjectId: binding.googleDataManager.quotaProjectId };
}
function scopeDigest(binding, assetRef, targets, principal, actionScope) {
  return A.hash({ target: resource(binding, assetRef, targets), actionScope,
    principal: { id: principal.id, keyId: principal.keyId, publicKey: principal.publicKey } });
}
module.exports = { OPERATIONS, bindingSchema, validate, validateBinding, resource, scopeDigest };
