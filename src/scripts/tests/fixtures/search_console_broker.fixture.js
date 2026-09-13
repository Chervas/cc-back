'use strict';
const assert = require('node:assert/strict');
const { createSearchConsoleBroker } = require('../../../services/searchConsoleBroker.service');
const contract = require('../../../../services/integrations-broker/src/google-search-console-contract');
function searchConsoleFixture() {
  const resource = contract.site('sc-domain:example.invalid');
  const mapping = { id: 91, clinicaId: 71, googleConnectionId: 81, siteUrl: resource.siteUrl, isActive: true,
    broker_read_connection_ref: 'connection:sc-qa', broker_read_asset_ref: resource.assetRef };
  const record = { site_hash: resource.siteHash, site_url: resource.siteUrl, mapping_id: 91, clinica_id: 71, google_connection_id: 81,
    google_user_id: 'fictitious-subject', connection_ref: mapping.broker_read_connection_ref, asset_ref: resource.assetRef, state: 'active' };
  const connection = { id: 81, googleUserId: 'fictitious-subject', credentials_external: 1 };
  for (const field of ['accessToken', 'refreshToken']) Object.defineProperty(connection, field, { get: () => assert.fail('No provider credentials in API') });
  const state = { mapping: { ...mapping }, record: { ...record }, connection, enabled: true, at: 1000, calls: [], checks: 0, logs: [], response: null, afterCall: null };
  const client = { execute: async command => {
    state.calls.push(command); assert.equal(command.connectionRef, record.connection_ref); assert.equal(command.assetRef, resource.assetRef); assert.equal(command.tenantRef, 'clinic:71');
    const family = command.operation.slice(contract.PREFIX.length).split('.')[0]; const payload = command.payload;
    const data = state.response ? await state.response(command) : family === 'inspection'
      ? { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Indexed', privateField: 'FICTITIOUS_HIDDEN' } } }
      : { rows: [{ keys: family === 'timeseries' ? [payload.startDate] : family === 'pages' ? ['https://example.invalid/page']
        : [payload.startDate, 'FICTITIOUS_QUERY', 'https://example.invalid/page'], clicks: 2, impressions: 4, ctr: 0.5, position: 1 }],
        ...(family === 'queries' ? { nextPageToken: null, rowLimitReached: false } : {}), privateField: 'FICTITIOUS_HIDDEN' };
    await state.afterCall?.(); return { data };
  } };
  const create = () => createSearchConsoleBroker({ client, now: () => state.at, enabled: () => state.enabled,
    loadMapping: async id => { assert.equal(id, 91); return state.mapping; },
    loadBinding: async hash => { assert.equal(hash, resource.siteHash); return state.record; },
    loadConnection: async (id, subject) => { assert.equal(id, 81); assert.equal(subject, 'fictitious-subject'); state.checks++; return state.connection; } });
  return { state, resource, mapping, record, service: create(), create };
}
module.exports = { searchConsoleFixture };
