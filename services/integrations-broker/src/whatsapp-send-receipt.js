'use strict';
const { createHash } = require('node:crypto');
const { canonical } = require('./canonical');
const C = require('./whatsapp-authorized-contract');
const E = require('./whatsapp-onboarding-contract');
const { fail } = require('./errors');
const READ = 'meta.whatsapp.authorized.send-status.v1';
function validate(payload) {
  if (!C.keys(payload, ['authorizationId', 'phoneId', 'intentId', 'send']) || !E.uuid(payload.intentId)
    || payload.authorizationId !== payload.send?.authorizationId || payload.phoneId !== payload.send?.phoneId) fail('invalid_request');
  C.validateSend(payload.send); return payload;
}
function project(value) {
  if (!C.keys(value, ['state', 'result']) || !['absent', 'accepted', 'unknown'].includes(value.state)) fail('provider_failed');
  if (value.state === 'accepted') return { state: value.state, result: C.projectResult(value.result) };
  if (value.result !== null) fail('provider_failed');
  return { state: value.state, result: null };
}
function operation({ registry, store }) {
  return Object.freeze({ provider: C.PROVIDER, effect: 'read', secretless: true, persistResult: false,
    validate, authorize: input => registry.authorize(input), project,
    async execute({ payload, binding, tenantRef, assetRef, principalId, assertActive }) {
      assertActive(); registry.assert(binding);
      const row = store.db.prepare('SELECT digest,state,result FROM commands WHERE principal=? AND id=?').get(principalId, payload.intentId);
      if (!row) return { state: 'absent', result: null };
      const digest = createHash('sha256').update(canonical({ operation: C.SEND, tenantRef,
        connectionRef: binding.connectionRef, assetRef, payload: payload.send })).digest('hex');
      // Matching the original digest proves actor, clinic, connection, number
      // and exact payload; a guessed UUID is never an authorization to read it.
      if (row.digest !== digest) fail('scope_denied');
      if (row.state !== 'completed' || !row.result) return { state: 'unknown', result: null };
      return { state: 'accepted', result: JSON.parse(row.result).data };
    },
  });
}
module.exports = { READ, validate, project, operation };
