'use strict';
const { createAnalyticsBroker, safe } = require('../../../services/analyticsBroker.service');
const { analyticsReport } = require('../../../../services/integrations-broker/test/analytics-helpers');
function analyticsFixture() {
  const mapping = { id: 91, clinicaId: 71, googleConnectionId: 81, propertyName: 'properties/123', isActive: true,
    broker_read_connection_ref: 'connection:ga-qa', broker_read_asset_ref: 'ga4:123' };
  const record = { property_name: 'properties/123', mapping_id: 91, connection_ref: 'connection:ga-qa', asset_ref: 'ga4:123',
    clinica_id: 71, google_connection_id: 81, google_user_id: 'fictitious-subject', state: 'active' };
  const connection = { id: 81, googleUserId: 'fictitious-subject', credentials_external: 1 };
  for (const name of ['accessToken', 'refreshToken']) Object.defineProperty(connection, name, { get() { throw Error('FICTITIOUS_HIDDEN_CREDENTIAL_READ'); } });
  const state = { mapping: { ...mapping }, record: { ...record }, connection, calls: [], metadataReads: 0, enabled: true, at: Date.now(), logs: [] };
  const create = () => ({ ...createAnalyticsBroker({ enabled: () => state.enabled, now: () => state.at,
    loadMapping: async id => { state.metadataReads++; await state.beforeMappingRead?.(); if (state.sqlFailure) throw Error('FICTITIOUS_SQL_DETAIL'); return id === 91 ? state.mapping : null; },
    loadBindings: async property => { state.metadataReads++; return property === 'properties/123' ? [...(state.record ? [state.record] : []), ...(state.otherBindings || [])] : []; },
    loadRevocations: async () => state.revocations || [],
    loadConnection: async () => { state.metadataReads++; return state.connection; },
    client: { execute: async command => {
      state.calls.push(command); await state.afterCall?.();
      const family = command.operation.slice('google.analytics.'.length).split('.')[0];
      return { data: state.response ? state.response(command) : { ...analyticsReport(family, { start: command.payload.startDate }), nextPageToken: null, rowLimitReached: false } };
    } },
  }), safe });
  return { mapping, record, state, create, service: create() };
}
module.exports = { analyticsFixture, analyticsReport };
