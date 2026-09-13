'use strict';
const { createHash } = require('node:crypto');
const ADS = require('../../services/integrations-broker/src/google-ads-contract');
const { positive } = require('../../services/platform-audit/src/google-property-disconnect-event');
const { fromRevocation } = require('../../services/platform-audit/src/google-ads-disconnect-event');
const IDENTITY_FIELDS = ['tuple_hash', 'customer_id', 'connection_ref', 'asset_ref', 'tenant_clinic_id', 'google_connection_id', 'google_user_id', 'login_customer_id'];
const FIELDS = [...IDENTITY_FIELDS, 'scope_key', 'clinic_ids', 'mapping_ids'];
const fail = () => { throw Object.assign(Error('google_ads_revocation_unavailable'), { code: 'google_ads_revocation_unavailable', httpStatus: 503 }); };
const tupleHash = row => createHash('sha256').update(JSON.stringify([Number(row.tenant_clinic_id), row.connection_ref, row.asset_ref])).digest('hex');
function ids(values, empty = false) {
  if (!Array.isArray(values) || values.length > 1000 || !empty && !values.length || values.some(v => !positive(String(v)))) fail();
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}
function storedIds(value) {
  if (typeof value !== 'string' || value.length > 12000) fail();
  let rows; try { rows = JSON.parse(value); } catch { fail(); }
  const result = ids(rows); if (JSON.stringify(result) !== value) fail(); return result;
}
function scopeKey(value) {
  if (typeof value !== 'string' || !/^(clinic|group):[1-9]\d{0,9}$/.test(value) || !positive(value.split(':')[1])) fail(); return value;
}
function identity(row) {
  if (!row || !ADS.customer(row.customer_id) || row.asset_ref !== 'ads:' + row.customer_id
    || !positive(String(row.tenant_clinic_id)) || !positive(String(row.google_connection_id))
    || typeof row.connection_ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(row.connection_ref)
    || typeof row.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.google_user_id) || row.google_user_id === 'unknown'
    || row.login_customer_id !== null && !ADS.customer(row.login_customer_id) || row.tuple_hash !== tupleHash(row)) fail();
  return Object.fromEntries(IDENTITY_FIELDS.map(k => [k, ['tenant_clinic_id', 'google_connection_id'].includes(k) ? Number(row[k]) : row[k]]));
}
function validate(row) {
  identity(row); scopeKey(row.scope_key); storedIds(row.mapping_ids);
  if (!storedIds(row.clinic_ids).includes(Number(row.tenant_clinic_id)) || !['pending', 'confirmed'].includes(row.state)) fail();
  try { fromRevocation(row, 'attempted', new Date(row.requested_at)); } catch { fail(); } return row;
}
module.exports = { ADS, IDENTITY_FIELDS, FIELDS, tupleHash, identity, validate, ids, storedIds, scopeKey, fail, positive };
