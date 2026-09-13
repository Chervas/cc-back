'use strict';
const { createHash } = require('node:crypto');
const { fromRevocation, positive } = require('../../services/platform-audit/src/google-property-disconnect-event');
const SC = require('../../services/integrations-broker/src/google-search-console-contract');
const GA = require('../../services/integrations-broker/src/google-analytics-contract');
const KINDS = Object.freeze({ search_console: { contract: SC, model: 'SearchConsoleBrokerBinding', resourceField: 'site_url',
  mappingModel: 'ClinicWebAsset', mappingResourceField: 'siteUrl', modeField: 'search_console_assignment_mode', primaryField: 'search_console_primary_asset_id' },
analytics: { contract: GA, model: 'AnalyticsBrokerBinding', resourceField: 'property_name', mappingModel: 'ClinicAnalyticsProperty',
  mappingResourceField: 'propertyName', modeField: 'analytics_assignment_mode', primaryField: 'analytics_primary_property_id' } });
const FIELDS = ['kind', 'resource', 'connection_ref', 'asset_ref', 'clinica_id', 'google_connection_id', 'google_user_id', 'tuple_hash'];
const fail = () => { throw Object.assign(Error('google_property_revocation_unavailable'), { code: 'google_property_revocation_unavailable', httpStatus: 503 }); };
const tupleHash = row => createHash('sha256').update(JSON.stringify([row.kind, Number(row.clinica_id), row.connection_ref, row.asset_ref])).digest('hex');
function identity(row) {
  if (!Object.hasOwn(KINDS, row.kind) || !positive(String(row.clinica_id)) || !positive(String(row.google_connection_id))
    || typeof row.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.google_user_id) || row.google_user_id === 'unknown'
    || typeof row.connection_ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(row.connection_ref)) fail();
  let resource; try { resource = row.kind === 'search_console' ? SC.site(row.resource) : GA.property(row.resource); } catch { fail(); }
  if (row.asset_ref !== resource.assetRef || row.tuple_hash !== tupleHash(row)) fail();
  return Object.fromEntries(FIELDS.map(k => [k, ['clinica_id', 'google_connection_id'].includes(k) ? Number(row[k]) : row[k]]));
}
function validate(row) {
  identity(row); if (!['pending', 'confirmed'].includes(row.state)) fail();
  try { fromRevocation(row, 'attempted', new Date(row.requested_at)); } catch { fail(); }
  return row;
}
function fromBinding(kind, row) {
  if (!Object.hasOwn(KINDS, kind) || !positive(String(row.mapping_id)) || !['active', 'blocked'].includes(row.state)) fail();
  const value = { ...row, kind, resource: row[KINDS[kind].resourceField] }; value.tuple_hash = tupleHash(value);
  const result = identity(value);
  if (kind === 'search_console' && row.site_hash !== SC.site(value.resource).siteHash) fail();
  return result;
}
function inspectRevocations(kind, assetRef, clinicId, connectionRef, rows) {
  if (!Array.isArray(rows) || rows.length > 1000 || new Set(rows.map(r => r.tuple_hash)).size !== rows.length) fail();
  for (const row of rows) {
    validate(row); if (row.kind !== kind || row.asset_ref !== assetRef) fail();
    if (Number(row.clinica_id) === Number(clinicId) && row.connection_ref === connectionRef) {
      throw Object.assign(Error('asset_revoked'), { code: 'asset_revoked' });
    }
  }
  return rows.length > 0;
}
module.exports = { KINDS, FIELDS, tupleHash, identity, validate, fromBinding, inspectRevocations, fail, positive };
