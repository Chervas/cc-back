'use strict';
const assert = require('node:assert/strict');
const { scopeFixture } = require('./google_ads_broker_scope.fixture');
const { createGoogleAdsBroker } = require('../../../services/googleAdsBroker.service');
const { createGoogleAdsDiscovery } = require('../../../services/googleAdsDiscovery.service');
function adsDiscoveryFixture() {
  const f = scopeFixture(); const state = f.state;
  Object.assign(state, { managed: true, allowed: true, session: true, at: 0, providerCalls: [], validation: 0, logs: [] });
  const broker = createGoogleAdsBroker({ ...f.options, now: () => state.at, client: { execute: async command => {
    assert.equal(command.operation, 'google.ads.discovery.read.v1'); assert.deepEqual(command.payload, {});
    state.providerCalls.push(command); await state.afterCall?.();
    return { requestId: command.requestId, data: { results: [{ customer: { id: command.assetRef.slice(4), descriptiveName: 'Fictitious account',
      manager: state.manager === true, currencyCode: 'EUR', timeZone: 'Europe/Madrid', status: state.accountStatus || 'ENABLED' } }], nextPageToken: null } };
  } } });
  const service = createGoogleAdsDiscovery({ broker, enabled: () => state.enabled, now: () => state.at,
    hasManaged: async () => { if (state.registryFailed) throw Error('FICTITIOUS_SQL_SECRET'); return state.managed; },
    snapshot: async () => { await state.beforeSnapshot?.(); return structuredClone({ bindings: state.bindings, mappings: state.mappings,
      clinics: state.clinics, shared: state.shared }); } });
  const request = { clinicIds: [59, 71], connectionId: 2, scopeKey: 'group:5', revalidate: async managed => {
    state.validation++; await state.onValidation?.();
    if (!state.session || managed && state.legacySession) throw Object.assign(Error('google_discovery_session_required'), { code: 'google_discovery_session_required' });
    if (!state.allowed) throw Object.assign(Error('google_discovery_scope_forbidden'), { code: 'google_discovery_scope_forbidden' });
  } };
  return { ...f, broker, service, request };
}
module.exports = { adsDiscoveryFixture };
