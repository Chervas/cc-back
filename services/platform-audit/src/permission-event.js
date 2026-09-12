'use strict';
const { UUID, fail } = require('./event');
const { FEATURE_KEYS, ROLE_CODES, PERMISSION_ACTIONS } = require('./access-policy-contract');
const { stamp } = require('./view-contract');
const BASES = ['not_evaluated', 'authenticated', 'global_admin', 'scope_staff', 'scope_owner', 'scope_denied'];
const EFFECTS = ['inherit', 'allow', 'deny'];
const id = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v);
function exact(v, keys) { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(); }
function permissionEvent(v) {
  exact(v, ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor', 'sessionRef',
    'scope', 'featureKey', 'roleCode', 'requestedEffect', 'previousEffect', 'resultCount', 'scopeClinicCount', 'authorizationBasis',
    'authorizationPolicyVersion', 'capturePolicy']); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  if (v.version !== 4 || !UUID.test(v.eventId) || typeof v.eventId !== 'string' || !UUID.test(v.correlationId) || typeof v.correlationId !== 'string'
    || !stamp(v.occurredAt) || !PERMISSION_ACTIONS.includes(v.action) || v.actor.type !== 'user' || !id(v.actor.id)
    || !(v.sessionRef === null || typeof v.sessionRef === 'string' && UUID.test(v.sessionRef))
    || !(v.scope.type === 'platform' && v.scope.id === null || ['group', 'clinic'].includes(v.scope.type) && id(v.scope.id))
    || !(v.featureKey === null || FEATURE_KEYS.includes(v.featureKey)) || !(v.roleCode === null || ROLE_CODES.includes(v.roleCode))
    || !(v.requestedEffect === null || EFFECTS.includes(v.requestedEffect)) || !(v.previousEffect === null || EFFECTS.includes(v.previousEffect))
    || !BASES.includes(v.authorizationBasis) || typeof v.authorizationPolicyVersion !== 'string' || !/^[a-f0-9]{64}$/.test(v.authorizationPolicyVersion)
    || v.capturePolicy !== 'permissions-durable-v1') fail();
  const mutation = v.action === 'permission.override.change';
  if (!mutation && (v.roleCode !== null || v.requestedEffect !== null || v.previousEffect !== null)) fail();
  if (v.action === 'permission.catalog.read' && (v.scope.type !== 'platform' || v.featureKey !== null)
    || v.action === 'permission.assignments.read' && v.featureKey !== null) fail();
  if (v.stage === 'attempted') {
    if (v.outcome !== 'unknown' || v.reason !== 'request_received' || v.authorizationBasis !== 'not_evaluated'
      || v.resultCount !== null || v.scopeClinicCount !== null || v.previousEffect !== null) fail();
  } else if (v.stage === 'completed') {
    if (!Number.isSafeInteger(v.resultCount) || v.resultCount < 0 || v.resultCount > 1000000
      || !Number.isSafeInteger(v.scopeClinicCount) || v.scopeClinicCount < 0 || v.scopeClinicCount > 1000000) fail();
    if (v.outcome === 'success') {
      if (!['authenticated', 'global_admin', 'scope_staff', 'scope_owner'].includes(v.authorizationBasis)) fail();
      if (mutation) {
        if (!['override_changed', 'override_unchanged'].includes(v.reason) || !v.featureKey || !v.roleCode || !v.requestedEffect || !v.previousEffect
          || v.scope.type === 'platform' || !['global_admin', 'scope_owner'].includes(v.authorizationBasis)
          || (v.reason === 'override_unchanged') !== (v.requestedEffect === v.previousEffect)
          || v.resultCount !== (v.requestedEffect === v.previousEffect ? 0 : 1)
          || v.authorizationBasis === 'scope_owner' && v.scopeClinicCount < 1) fail();
      } else if (v.reason !== 'records_prepared') fail();
      if (v.action === 'permission.assignments.read' && v.scope.type === 'platform') fail();
    } else if (v.outcome === 'denied') {
      if (!['request_invalid', 'access_denied'].includes(v.reason) || v.resultCount !== 0 || v.previousEffect !== null
        || !['not_evaluated', 'scope_denied'].includes(v.authorizationBasis)) fail();
    } else if (v.outcome !== 'error' || v.reason !== 'operation_unconfirmed' || v.resultCount !== 0 || v.previousEffect !== null) fail();
  } else fail();
  return Object.fromEntries(['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor', 'sessionRef',
    'scope', 'featureKey', 'roleCode', 'requestedEffect', 'previousEffect', 'resultCount', 'scopeClinicCount', 'authorizationBasis',
    'authorizationPolicyVersion', 'capturePolicy'].map(k => [k, k === 'actor' ? { type: 'user', id: v.actor.id } : k === 'scope' ? { type: v.scope.type, id: v.scope.id } : v[k]]));
}
module.exports = { permissionEvent };
