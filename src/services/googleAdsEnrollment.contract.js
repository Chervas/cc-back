'use strict';
const { createHash } = require('node:crypto');
const { positive, customer } = require('./googleAdsBrokerScope.service');
const { UUID } = require('../../services/platform-audit/src/event');
const broker = require('../../services/integrations-broker/src/google-ads-enrollment-contract');
const fail = (code = 'google_ads_enrollment_invalid') => { throw Object.assign(Error(code), { code }); };
const ref = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const HASH = /^[a-f0-9]{64}$/;
const SCOPE_FIELDS = ['scope_key', 'google_connection_id', 'google_user_id', 'connection_ref', 'asset_ref',
  'tenant_clinic_id', 'root_customer_id', 'login_customer_id', 'state'];
const REQUEST_FIELDS = ['enrollment_id', 'scope_key', 'google_connection_id', 'google_user_id', 'connection_ref', 'scope_ref',
  'tenant_clinic_id', 'customer_id', 'login_customer_id', 'clinic_ids', 'clinic_count', 'clinic_digest', 'scope_digest', 'mapping_id',
  'actor_user_id', 'session_ref', 'session_expires_at', 'prepare_request_id', 'activate_request_id', 'revoke_request_id',
  'state', 'requested_at', 'updated_at', 'attempts', 'next_attempt_at', 'lease_token', 'lease_until', 'last_error'];
const STATES = ['prepare_pending', 'prepared', 'activate_pending', 'activation_confirmed', 'active', 'revoke_pending', 'revoked'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scopeKey(value) {
  if (typeof value !== 'string' || !/^(clinic|group):[1-9]\d{0,9}$/.test(value) || !positive(value.split(':')[1])) fail(); return value;
}
function clinicIds(values) {
  if (!Array.isArray(values) || !values.length || values.length > 1000 || values.some(v => !positive(v))) fail();
  const result = [...new Set(values.map(Number))].sort((a, b) => a - b);
  if (result.length !== values.length) fail(); return result;
}
function scope(row) {
  if (!row || !positive(row.google_connection_id) || !positive(row.tenant_clinic_id)
    || !ref(row.connection_ref) || typeof row.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.google_user_id)
    || row.google_user_id === 'unknown' || !['blocked', 'active'].includes(row.state)) fail();
  scopeKey(row.scope_key);
  if (row.asset_ref !== 'ads-enroll:' + row.scope_key || customer(row.root_customer_id) !== row.root_customer_id
    || row.login_customer_id !== null && customer(row.login_customer_id) !== row.login_customer_id
    || row.scope_key.startsWith('clinic:') && row.scope_key !== 'clinic:' + Number(row.tenant_clinic_id)) fail();
  return Object.fromEntries(SCOPE_FIELDS.map(k => [k, ['google_connection_id', 'tenant_clinic_id'].includes(k) ? Number(row[k]) : row[k]]));
}
function request(row) {
  if (!row || !UUID.test(row.enrollment_id) || !UUID.test(row.session_ref) || !positive(row.actor_user_id)
    || !positive(row.google_connection_id) || !positive(row.tenant_clinic_id) || !ref(row.connection_ref)
    || !/^[A-Za-z0-9._-]{1,128}$/.test(row.google_user_id || '') || row.google_user_id === 'unknown'
    || row.scope_ref !== 'ads-enroll:' + scopeKey(row.scope_key) || customer(row.customer_id) !== row.customer_id
    || row.login_customer_id !== null && customer(row.login_customer_id) !== row.login_customer_id
    || row.mapping_id !== null && !positive(row.mapping_id) || !HASH.test(row.scope_digest) || !STATES.includes(row.state)) fail();
  for (const key of ['prepare_request_id', 'activate_request_id', 'revoke_request_id']) if (!UUID.test(row[key])) fail();
  if (new Set(['enrollment_id', 'prepare_request_id', 'activate_request_id', 'revoke_request_id'].map(k => row[k])).size !== 4) fail();
  let ids; try { ids = clinicIds(JSON.parse(row.clinic_ids)); } catch { fail(); }
  if (JSON.stringify(ids) !== row.clinic_ids || Number(row.clinic_count) !== ids.length || row.clinic_digest !== digest(ids)
    || !ids.includes(Number(row.tenant_clinic_id)) || row.scope_key.startsWith('clinic:') && (ids.length !== 1 || row.scope_key !== 'clinic:' + ids[0])) fail();
  for (const key of ['requested_at', 'updated_at', 'session_expires_at', 'next_attempt_at']) {
    if (!(row[key] instanceof Date) || !Number.isFinite(row[key].getTime())) fail();
  }
  if (row.session_expires_at <= row.requested_at || row.updated_at < row.requested_at
    || !Number.isSafeInteger(Number(row.attempts)) || Number(row.attempts) < 0 || Number(row.attempts) > 1000000000
    || row.last_error !== null && (typeof row.last_error !== 'string' || !/^[a-z0-9_]{1,64}$/.test(row.last_error))
    || ['prepared', 'activate_pending', 'activation_confirmed', 'active'].includes(row.state) && !positive(row.mapping_id)
    || row.lease_token !== null && !UUID.test(row.lease_token)
    || row.lease_until !== null && (!(row.lease_until instanceof Date) || !Number.isFinite(row.lease_until.getTime()))
    || (row.lease_token === null) !== (row.lease_until === null)) fail();
  return { ...Object.fromEntries(REQUEST_FIELDS.map(k => [k, row[k]])), clinicIds: ids };
}
function payload(row) {
  const v = request(row); return { enrollmentId: v.enrollment_id, customerId: v.customer_id,
    clinicCount: v.clinicIds.length, clinicSetDigest: v.clinic_digest };
}
module.exports = { fail, ref, positive, customer, UUID, HASH, SCOPE_FIELDS, REQUEST_FIELDS, STATES, digest, scopeKey, clinicIds, scope, request, payload, broker };
