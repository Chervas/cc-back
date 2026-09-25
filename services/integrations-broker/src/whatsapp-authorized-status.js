'use strict';

const C = require('./whatsapp-authorized-contract');
const E = require('./whatsapp-onboarding-contract');
const { fail } = require('./errors');

const READ = 'meta.whatsapp.authorized.status.read.v1';

function validate(payload) {
  if (!C.keys(payload, ['authorizationId', 'phoneId'])
    || !E.uuid(payload.authorizationId) || !E.id(payload.phoneId)) fail('invalid_request');
  return payload;
}

function project(raw) {
  if (!C.keys(raw, ['permissionStatus']) || !['connected', 'disconnected'].includes(raw.permissionStatus)) fail('provider_failed');
  return { permissionStatus: raw.permissionStatus };
}

function operation({ registry, store }) {
  if (typeof registry?.authorize !== 'function' || typeof store?.connectionState !== 'function') fail('invalid_request');
  return Object.freeze({
    provider: C.PROVIDER,
    control: 'whatsapp_authorized_status',
    effect: 'read',
    secretless: true,
    persistResult: false,
    validate,
    authorize: input => registry.authorize(input),
    execute({ payload, binding, tenantRef, assetRef }) {
      const value = registry.assert(binding);
      if (payload.authorizationId !== value.definition.authorizationId || payload.phoneId !== value.definition.phoneId) fail('scope_denied');
      store.assertAssetActive({ tenantRef, connectionRef: binding.connectionRef, assetRef });
      const state = store.connectionState(binding.connectionRef);
      if (state === 'revoked') return { permissionStatus: 'disconnected' };
      if (state !== 'active') fail('connection_blocked');
      return { permissionStatus: 'connected' };
    },
    project,
  });
}

module.exports = { READ, validate, project, operation };
