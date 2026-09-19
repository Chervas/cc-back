'use strict';
const assert = require('node:assert/strict');
const { createGooglePropertyDiscovery, safe, status } = require('../../../services/googlePropertyDiscovery.service');
const { createAnalyticsBroker } = require('../../../services/analyticsBroker.service');
const { createSearchConsoleBroker } = require('../../../services/searchConsoleBroker.service');
const sc = require('../../../../services/integrations-broker/src/google-search-console-contract');
const SITE = sc.site('sc-domain:example.invalid');
const propertyData = { name: 'properties/123', displayName: 'Fictitious property', propertyType: 'PROPERTY_TYPE_ORDINARY', parent: 'accounts/456', account: 'accounts/456' };
function propertyFixture(kind = 'analytics') {
  const mapping = { id: 91, clinicaId: 71, googleConnectionId: 81, isActive: true,
    ...(kind === 'analytics' ? { propertyName: 'properties/123' } : { siteUrl: SITE.siteUrl }),
    broker_read_connection_ref: 'connection:discovery-qa', broker_read_asset_ref: kind === 'analytics' ? 'ga4:123' : SITE.assetRef };
  const record = { mapping_id: 91, clinica_id: 71, google_connection_id: 81, google_user_id: 'fictitious-subject',
    ...(kind === 'analytics' ? { property_name: 'properties/123' } : { site_hash: SITE.siteHash, site_url: SITE.siteUrl }),
    connection_ref: mapping.broker_read_connection_ref, asset_ref: mapping.broker_read_asset_ref, state: 'active' };
  const connection = { id: 81, googleUserId: 'fictitious-subject', credentials_external: 1 };
  for (const key of ['accessToken', 'refreshToken']) Object.defineProperty(connection, key, { get() { assert.fail('FICTITIOUS_SECRET_HYDRATION'); } });
  const state = { at: 1000, managed: true, enabled: true, records: [{ ...record }], mappings: [{ ...mapping }], connection, calls: [], validation: 0,
    response: kind === 'analytics' ? { ...propertyData } : { siteUrl: SITE.siteUrl, permissionLevel: 'siteOwner' }, allowed: true, session: true, logs: [] };
  const loadMapping = async id => { await state.beforeMapping?.(); return state.mappings.find(row => row.id === id); };
  const deps = { enabled: () => state.enabled, now: () => state.at, loadMapping, loadBindings: async () => state.records,
    loadRevocations: async () => state.revocations || [],
    loadConnection: async () => state.connection,
    client: { execute: async (command, budget) => { assert(budget.timeoutMs > 0 && budget.timeoutMs <= 30000); state.calls.push(command);
      await state.afterCall?.(); return { data: structuredClone(state.response) }; } } };
  const reader = kind === 'analytics' ? createAnalyticsBroker(deps) : createSearchConsoleBroker(deps);
  const service = createGooglePropertyDiscovery({ readers: { [kind]: reader }, now: () => state.at, enabled: () => state.enabled,
    hasManaged: async () => { if (state.registryFailure) throw Error('FICTITIOUS_SQL_SECRET'); return state.managed; },
    listBindings: async (_kind, clinicIds, connectionId, effectiveIds = []) => { await state.beforeList?.(); return state.records.filter(row =>
      (clinicIds.includes(row.clinica_id) || effectiveIds.includes(row.mapping_id)) && row.google_connection_id === connectionId); },
    loadMapping: (_kind, id) => loadMapping(id),
  });
  const request = { kind, connectionId: 81, clinicIds: [71], revalidate: async managed => {
    state.validation++; assert.equal(managed, true);
    if (!state.allowed) throw Object.assign(Error('forbidden'), { code: 'google_discovery_scope_forbidden' });
  } };
  return { state, mapping, record, reader, request, service: { ...service, safe, status } };
}
module.exports = { propertyFixture, propertyData };
